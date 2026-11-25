import { createHash } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import {
  auditLog, tentashipBadgeAwards, tentashipBadgeDefinitionVersions, tentashipBadgeDefinitions, tentashipBadgeRevocations,
  type BadgeParticipantType,
} from '../db/schema';
import { AppError } from '../lib/errors';
import { IMPLEMENTED_BADGE_METRICS, parseBadgeRule, type BadgeRule } from './badge-rules';

export const REVOCATION_REASONS = ['evidence_reversed', 'fraud_confirmed', 'eligibility_lost', 'issued_in_error'] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

export type EarnedBadge = {
  awardId: string; definitionKey: string; version: number; names: Record<string, string>; descriptions: Record<string, string>; awardedAt: string;
};
export type AwardAudit = { actorUserId?: string | null; ipAddress?: string | null; userAgent?: string | null };

const lockKey = (type: BadgeParticipantType, id: string) => sql`hashtextextended(${`tentaship-badge-award:${type}:${id}`}, 0)`;

/**
 * Verified server-side SOURCE records for one metric: the ordered ids that count toward a rule. Evidence is read ONLY from server-owned tables
 * written by already-authorised server flows (a Community survey award decision; a business post that passed moderation). Nothing the client or
 * a cashier sends is ever an input, and there is no cashier route to this module. Reversed decisions and moderation-suspended posts do not count.
 */
async function sourceIds(db: Db, rule: BadgeRule, participantId: string): Promise<string[]> {
  const window = rule.windowDays === undefined ? sql`` : sql`and ${sql.raw(rule.metric === 'community_survey_completions' ? 'evaluated_at' : 'published_at')} >= now() - make_interval(days => ${rule.windowDays})`;
  const result = rule.metric === 'community_survey_completions'
    ? await db.execute<{ id: string }>(sql`select id from community_point_award_decisions
        where customer_id = ${participantId} and source_type = 'survey_completion' and status = 'awarded' ${window}
        order by evaluated_at, id limit ${rule.threshold}`)
    : await db.execute<{ id: string }>(sql`select id from network_posts
        where content_class = 'business' and business_id = ${participantId} and published_at is not null and state <> 'suspended' ${window}
        order by published_at, id limit ${rule.threshold}`);
  return (result.rows ?? []).map((r) => r.id);
}

/**
 * TB-03: the server-side award engine. A badge is computed, never claimed: the participant (or the system) asks for an EVALUATION, the server
 * reads verified evidence, and any award is an idempotent append to the ledger. Duplicate and replayed awards are impossible (database
 * uniqueness per definition+participant and per definition+evidence); concurrent evaluations of one participant are serialised by an advisory
 * lock and collapse to the first insert. Awards carry the definition VERSION and rule hash that justified them, so a later version never
 * rewrites history. No award is ever created by a cashier transaction: there is no such input and no cashier route.
 */
export class BadgeAwardService {
  constructor(private readonly db: Db) {}

  /** Evaluates every ACTIVE definition for this participant; returns only the awards created by THIS call. Safe to call repeatedly. */
  async evaluate(type: BadgeParticipantType, participantId: string, audit: AwardAudit = {}): Promise<EarnedBadge[]> {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db.execute(sql`select pg_advisory_xact_lock(${lockKey(type, participantId)})`);
      const active = await db
        .select({ v: tentashipBadgeDefinitionVersions, key: tentashipBadgeDefinitions.key })
        .from(tentashipBadgeDefinitionVersions)
        .innerJoin(tentashipBadgeDefinitions, eq(tentashipBadgeDefinitions.id, tentashipBadgeDefinitionVersions.definitionId))
        .where(and(eq(tentashipBadgeDefinitions.participantType, type), eq(tentashipBadgeDefinitionVersions.status, 'active')))
        .orderBy(tentashipBadgeDefinitions.key);
      const created: EarnedBadge[] = [];
      for (const { v, key } of active) {
        let rule: BadgeRule;
        try { rule = parseBadgeRule(v.rule, type); } catch { continue; } // an unapproved/invalid rule never awards (fail closed)
        if (IMPLEMENTED_BADGE_METRICS[rule.metric] !== type) continue;
        const ids = await sourceIds(db, rule, participantId);
        if (ids.length < rule.threshold) continue;
        const [row] = await db.insert(tentashipBadgeAwards).values({
          definitionId: v.definitionId, definitionVersionId: v.id, participantType: type,
          customerId: type === 'customer' ? participantId : null, businessId: type === 'business' ? participantId : null,
          evidenceKind: rule.metric, evidenceRef: `${participantId}:${rule.metric}:${rule.threshold}`,
          evidenceHash: createHash('sha256').update(ids.join(',')).digest('hex'),
          evidence: { metric: rule.metric, threshold: rule.threshold, observed: ids.length, ...(rule.windowDays === undefined ? {} : { windowDays: rule.windowDays }), ruleHash: v.ruleHash },
        }).onConflictDoNothing().returning();
        if (!row) continue; // already awarded (or revoked): a revoked badge is never re-issued
        await db.insert(auditLog).values({
          businessId: type === 'business' ? participantId : null, actorUserId: audit.actorUserId ?? null, action: 'tentaship_badge.awarded',
          entityType: 'tentaship_badge_award', entityId: row.id, metadata: { outcome: 'success', definitionKey: key, version: v.version, participantType: type },
          ipAddress: audit.ipAddress ?? null, userAgent: audit.userAgent ?? null,
        });
        created.push({ awardId: row.id, definitionKey: key, version: v.version, names: v.names, descriptions: v.descriptions, awardedAt: row.awardedAt.toISOString() });
      }
      return created;
    });
  }

  /** The participant's CURRENT badges (awarded and not revoked), newest first. */
  async listEarned(type: BadgeParticipantType, participantId: string): Promise<EarnedBadge[]> {
    const column = type === 'customer' ? tentashipBadgeAwards.customerId : tentashipBadgeAwards.businessId;
    const rows = await this.db
      .select({ a: tentashipBadgeAwards, v: tentashipBadgeDefinitionVersions, key: tentashipBadgeDefinitions.key })
      .from(tentashipBadgeAwards)
      .innerJoin(tentashipBadgeDefinitionVersions, eq(tentashipBadgeDefinitionVersions.id, tentashipBadgeAwards.definitionVersionId))
      .innerJoin(tentashipBadgeDefinitions, eq(tentashipBadgeDefinitions.id, tentashipBadgeAwards.definitionId))
      .leftJoin(tentashipBadgeRevocations, eq(tentashipBadgeRevocations.awardId, tentashipBadgeAwards.id))
      .where(and(eq(column, participantId), isNull(tentashipBadgeRevocations.id)))
      .orderBy(desc(tentashipBadgeAwards.awardedAt), tentashipBadgeAwards.id);
    return rows.map(({ a, v, key }) => ({ awardId: a.id, definitionKey: key, version: v.version, names: v.names, descriptions: v.descriptions, awardedAt: a.awardedAt.toISOString() }));
  }

  /** Platform audit/history: every award with its revocation, newest first, aggregate evidence only. */
  async history(limit = 50) {
    const rows = await this.db
      .select({ a: tentashipBadgeAwards, key: tentashipBadgeDefinitions.key, r: tentashipBadgeRevocations })
      .from(tentashipBadgeAwards)
      .innerJoin(tentashipBadgeDefinitions, eq(tentashipBadgeDefinitions.id, tentashipBadgeAwards.definitionId))
      .leftJoin(tentashipBadgeRevocations, eq(tentashipBadgeRevocations.awardId, tentashipBadgeAwards.id))
      .orderBy(desc(tentashipBadgeAwards.awardedAt), tentashipBadgeAwards.id)
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map(({ a, key, r }) => ({
      awardId: a.id, definitionKey: key, participantType: a.participantType, customerId: a.customerId, businessId: a.businessId,
      awardedAt: a.awardedAt.toISOString(), evidence: a.evidence,
      revocation: r ? { reasonCode: r.reasonCode, revokedAt: r.revokedAt.toISOString() } : null,
    }));
  }

  /** Approved revocation (D-2). Idempotent: a second revoke returns the existing record. The award row itself is never changed or deleted. */
  async revoke(awardId: string, reason: RevocationReason, note: string, ctx: { actorUserId: string; ipAddress?: string | null; userAgent?: string | null }) {
    const text = note.trim();
    if (!text || text.length > 500) throw new AppError('A note of 1 to 500 characters is required.', 400, 'VALIDATION_ERROR');
    return this.db.transaction(async (tx) => {
      const [award] = await tx.select().from(tentashipBadgeAwards).where(eq(tentashipBadgeAwards.id, awardId)).limit(1);
      if (!award) throw new AppError('Badge award not found.', 404, 'BADGE_AWARD_NOT_FOUND');
      const [row] = await tx.insert(tentashipBadgeRevocations)
        .values({ awardId, reasonCode: reason, note: text, authorizedByUserId: ctx.actorUserId }).onConflictDoNothing().returning();
      if (!row) {
        const [existing] = await tx.select().from(tentashipBadgeRevocations).where(eq(tentashipBadgeRevocations.awardId, awardId)).limit(1);
        return { revoked: true as const, created: false, reasonCode: existing!.reasonCode, revokedAt: existing!.revokedAt.toISOString() };
      }
      await tx.insert(auditLog).values({
        businessId: award.businessId, actorUserId: ctx.actorUserId, action: 'tentaship_badge.revoked', entityType: 'tentaship_badge_award', entityId: awardId,
        metadata: { outcome: 'success', reasonCode: reason }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null,
      });
      return { revoked: true as const, created: true, reasonCode: row.reasonCode, revokedAt: row.revokedAt.toISOString() };
    });
  }
}
