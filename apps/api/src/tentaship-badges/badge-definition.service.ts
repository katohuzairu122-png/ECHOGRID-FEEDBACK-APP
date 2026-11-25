import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, tentashipBadgeDefinitions, tentashipBadgeDefinitionVersions, type BadgeParticipantType } from '../db/schema';
import { AppError } from '../lib/errors';
import { hashRule, parseBadgeRule, BadgeRuleError } from './badge-rules';

export const BADGE_LOCALES = ['en', 'ar', 'es', 'fr'] as const;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 400;

export type BadgeContentInput = { names: Record<string, string>; descriptions: Record<string, string>; rule: unknown };
export type ActorContext = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };

function cleanText(map: Record<string, string>, max: number, requireEnglish: boolean, label: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [locale, value] of Object.entries(map)) {
    if (!(BADGE_LOCALES as readonly string[]).includes(locale)) throw new AppError(`Unsupported language in ${label}.`, 400, 'VALIDATION_ERROR');
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > max) throw new AppError(`Each ${label} must be 1 to ${max} characters.`, 400, 'VALIDATION_ERROR');
    out[locale] = text;
  }
  if (requireEnglish && !out.en) throw new AppError(`An English ${label} is required.`, 400, 'VALIDATION_ERROR');
  return out;
}

const lockKey = (definitionId: string) => sql`hashtextextended(${'tentaship-badge-definition:' + definitionId}, 0)`;
const conflict = (message: string, code: string) => new AppError(message, 409, code);

/**
 * TB-02: platform administration of badge definitions. Creating a definition or version never awards anything. Versions are immutable
 * (database guard); a change is a new version, and exactly one version per definition can be active (partial unique index). Every change
 * writes its audit row in the same transaction. A rule that uses an unapproved metric is refused here, so it can never become active.
 */
export class BadgeDefinitionService {
  constructor(private readonly db: Db) {}

  private content(input: BadgeContentInput, participantType: BadgeParticipantType) {
    let rule;
    try { rule = parseBadgeRule(input.rule, participantType); } catch (e) {
      if (e instanceof BadgeRuleError) throw new AppError(e.message, e.code === 'BADGE_RULE_INVALID' ? 400 : 422, e.code);
      throw e;
    }
    return {
      names: cleanText(input.names, NAME_MAX, true, 'name'),
      descriptions: cleanText(input.descriptions, DESCRIPTION_MAX, false, 'description'),
      rule: rule as unknown as Record<string, unknown>, ruleHash: hashRule(rule),
    };
  }

  async createDefinition(input: { key: string; participantType: BadgeParticipantType } & BadgeContentInput, ctx: ActorContext) {
    const content = this.content(input, input.participantType);
    return this.db.transaction(async (tx) => {
      const [definition] = await tx.insert(tentashipBadgeDefinitions)
        .values({ key: input.key, participantType: input.participantType, createdByUserId: ctx.actorUserId })
        .onConflictDoNothing().returning();
      if (!definition) throw conflict('A badge with that key already exists.', 'BADGE_KEY_TAKEN');
      const [version] = await tx.insert(tentashipBadgeDefinitionVersions)
        .values({ definitionId: definition.id, version: 1, ...content, createdByUserId: ctx.actorUserId }).returning();
      await this.audit(tx as unknown as Db, 'tentaship_badge.definition_created', definition.id, ctx, { versionId: version!.id, version: 1 });
      return { definition, version: version! };
    });
  }

  async createVersion(definitionId: string, input: BadgeContentInput, ctx: ActorContext) {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(definitionId)})`);
      const [definition] = await tx.select().from(tentashipBadgeDefinitions).where(eq(tentashipBadgeDefinitions.id, definitionId)).limit(1);
      if (!definition) throw new AppError('Badge not found.', 404, 'BADGE_NOT_FOUND');
      const content = this.content(input, definition.participantType);
      const [latest] = await tx.select({ v: tentashipBadgeDefinitionVersions.version }).from(tentashipBadgeDefinitionVersions)
        .where(eq(tentashipBadgeDefinitionVersions.definitionId, definitionId)).orderBy(desc(tentashipBadgeDefinitionVersions.version)).limit(1);
      const version = (latest?.v ?? 0) + 1;
      const [row] = await tx.insert(tentashipBadgeDefinitionVersions)
        .values({ definitionId, version, ...content, createdByUserId: ctx.actorUserId }).returning();
      await this.audit(tx as unknown as Db, 'tentaship_badge.version_created', definitionId, ctx, { versionId: row!.id, version });
      return row!;
    });
  }

  /** Idempotent: activating the already-active version changes nothing. The previously active version is retired in the same transaction. */
  async activate(versionId: string, ctx: ActorContext) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(tentashipBadgeDefinitionVersions).where(eq(tentashipBadgeDefinitionVersions.id, versionId)).limit(1);
      if (!current) throw new AppError('Badge version not found.', 404, 'BADGE_NOT_FOUND');
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(current.definitionId)})`);
      const [fresh] = await tx.select().from(tentashipBadgeDefinitionVersions).where(eq(tentashipBadgeDefinitionVersions.id, versionId)).limit(1);
      if (!fresh) throw new AppError('Badge version not found.', 404, 'BADGE_NOT_FOUND');
      if (fresh.status === 'active') return fresh;
      if (fresh.status !== 'draft') throw conflict('Only a draft version can be activated.', 'BADGE_VERSION_NOT_DRAFT');
      const [definition] = await tx.select().from(tentashipBadgeDefinitions).where(eq(tentashipBadgeDefinitions.id, fresh.definitionId)).limit(1);
      // Re-validate at activation: the registry may have changed since the draft was written.
      this.content({ names: fresh.names, descriptions: fresh.descriptions, rule: fresh.rule }, definition!.participantType);
      const now = new Date();
      await tx.update(tentashipBadgeDefinitionVersions).set({ status: 'retired', retiredAt: now })
        .where(and(eq(tentashipBadgeDefinitionVersions.definitionId, fresh.definitionId), eq(tentashipBadgeDefinitionVersions.status, 'active')));
      const [row] = await tx.update(tentashipBadgeDefinitionVersions).set({ status: 'active', activatedAt: now })
        .where(eq(tentashipBadgeDefinitionVersions.id, versionId)).returning();
      await this.audit(tx as unknown as Db, 'tentaship_badge.version_activated', fresh.definitionId, ctx, { versionId, version: fresh.version });
      return row!;
    });
  }

  async retire(versionId: string, ctx: ActorContext) {
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(tentashipBadgeDefinitionVersions).where(eq(tentashipBadgeDefinitionVersions.id, versionId)).limit(1);
      if (!current) throw new AppError('Badge version not found.', 404, 'BADGE_NOT_FOUND');
      await tx.execute(sql`select pg_advisory_xact_lock(${lockKey(current.definitionId)})`);
      const [row] = await tx.update(tentashipBadgeDefinitionVersions).set({ status: 'retired', retiredAt: new Date() })
        .where(and(eq(tentashipBadgeDefinitionVersions.id, versionId), sql`${tentashipBadgeDefinitionVersions.status} IN ('draft','active')`)).returning();
      if (!row) return current; // already retired: idempotent
      await this.audit(tx as unknown as Db, 'tentaship_badge.version_retired', current.definitionId, ctx, { versionId, version: current.version });
      return row;
    });
  }

  async list() {
    const definitions = await this.db.select().from(tentashipBadgeDefinitions).orderBy(tentashipBadgeDefinitions.key);
    const versions = await this.db.select().from(tentashipBadgeDefinitionVersions)
      .orderBy(tentashipBadgeDefinitionVersions.definitionId, tentashipBadgeDefinitionVersions.version);
    return definitions.map((d) => ({ ...d, versions: versions.filter((v) => v.definitionId === d.id) }));
  }

  private async audit(db: Db, action: string, definitionId: string, ctx: ActorContext, metadata: Record<string, unknown>) {
    await db.insert(auditLog).values({
      businessId: null, actorUserId: ctx.actorUserId, action, entityType: 'tentaship_badge_definition', entityId: definitionId,
      metadata: { outcome: 'success', ...metadata }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
    });
  }
}
