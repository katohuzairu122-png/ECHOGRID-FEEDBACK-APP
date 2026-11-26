import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { auditLog, qualificationRuleVersions, shuffleCampaignVersions, shuffleCampaigns, shuffleEligibilitySnapshots, type ShuffleMode } from '../db/schema';
import { AppError } from '../lib/errors';
import { evaluateRuleForCustomer } from '../qualification/qualification-evaluator';

const LOCALES = ['en', 'ar', 'es', 'fr'];
export type Actor = { actorUserId: string; ipAddress?: string | null; userAgent?: string | null };
export type VersionContent = {
  qualificationRuleVersionId: string; minParticipants: number; maxCapacity: number;
  qualificationWindowStart: Date; qualificationWindowEnd: Date; entryAcceptanceDeadline: Date;
  disclosure: Record<string, string>; termsVersion: string; closureConditions: string; cancellationConditions: string;
};
const bad = (message: string, code = 'VALIDATION_ERROR') => new AppError(message, 422, code);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function cleanDisclosure(d: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d)) {
    if (!LOCALES.includes(k)) throw bad('Unsupported language in the disclosure.');
    const t = typeof v === 'string' ? v.trim() : '';
    if (!t || t.length > 2000) throw bad('Each disclosure must be 1 to 2000 characters.');
    out[k] = t;
  }
  if (!out.en) throw bad('An English disclosure is required.');
  return out;
}

/**
 * TSH-03 campaign configuration. Nothing here runs a campaign: no invitation, entry, selection, allocation or reward exists, and no version can be
 * released (release_state is fixed at not_released by the database). Limits (D-6), mode (D-3) and the disclosure (D-4) are ALWAYS supplied by an
 * administrator and never defaulted; the mode cannot change after creation (database FK). Eligibility is a reference to the shared qualification rule.
 */
export class ShuffleCampaignService {
  constructor(private readonly db: Db) {}

  private async content(tx: Db, c: VersionContent) {
    if (!Number.isInteger(c.minParticipants) || !Number.isInteger(c.maxCapacity) || c.minParticipants < 1 || c.maxCapacity < c.minParticipants) throw bad('Limits must be whole numbers with 1 <= minimum <= maximum capacity.', 'CAMPAIGN_LIMITS_INVALID');
    if (!(c.qualificationWindowEnd > c.qualificationWindowStart) || !(c.entryAcceptanceDeadline > c.qualificationWindowStart)) throw bad('The qualification window and acceptance deadline are inconsistent.', 'CAMPAIGN_DATES_INVALID');
    const disclosure = cleanDisclosure(c.disclosure);
    const [rule] = await tx.select({ id: qualificationRuleVersions.id, participantType: qualificationRuleVersions.participantType }).from(qualificationRuleVersions).where(eq(qualificationRuleVersions.id, c.qualificationRuleVersionId)).limit(1);
    if (!rule || rule.participantType !== 'customer') throw bad('Eligibility must reference an existing customer qualification rule version.', 'CAMPAIGN_RULE_INVALID');
    const disclosureHash = sha(JSON.stringify(Object.fromEntries(Object.entries(disclosure).sort(([a], [b]) => a.localeCompare(b)))));
    const contentHash = sha(JSON.stringify({ r: c.qualificationRuleVersionId, min: c.minParticipants, max: c.maxCapacity, ws: c.qualificationWindowStart.toISOString(), we: c.qualificationWindowEnd.toISOString(), dl: c.entryAcceptanceDeadline.toISOString(), dh: disclosureHash, t: c.termsVersion, cc: c.closureConditions, xc: c.cancellationConditions }));
    return { disclosure, disclosureHash, contentHash };
  }

  async createCampaign(input: { key: string; mode: ShuffleMode } & VersionContent, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const derived = await this.content(db, input);
      const [campaign] = await tx.insert(shuffleCampaigns).values({ key: input.key, mode: input.mode, createdByUserId: ctx.actorUserId }).onConflictDoNothing().returning();
      if (!campaign) throw new AppError('A campaign with that key already exists.', 409, 'CAMPAIGN_KEY_TAKEN');
      const [version] = await tx.insert(shuffleCampaignVersions).values({ campaignId: campaign.id, mode: campaign.mode, version: 1, ...this.values(input, derived), createdByUserId: ctx.actorUserId }).returning();
      await this.audit(db, 'shuffle_campaign.created', campaign.id, ctx, { versionId: version!.id, mode: input.mode });
      return { campaign, version: version! };
    });
  }

  private values(c: VersionContent, d: { disclosure: Record<string, string>; disclosureHash: string; contentHash: string }) {
    return {
      qualificationRuleVersionId: c.qualificationRuleVersionId, minParticipants: c.minParticipants, maxCapacity: c.maxCapacity,
      qualificationWindowStart: c.qualificationWindowStart, qualificationWindowEnd: c.qualificationWindowEnd, entryAcceptanceDeadline: c.entryAcceptanceDeadline,
      disclosure: d.disclosure, disclosureHash: d.disclosureHash, termsVersion: c.termsVersion, closureConditions: c.closureConditions, cancellationConditions: c.cancellationConditions, contentHash: d.contentHash,
    };
  }

  async createVersion(campaignId: string, input: VersionContent, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'shuffle-campaign:' + campaignId}, 0))`);
      const [campaign] = await tx.select().from(shuffleCampaigns).where(eq(shuffleCampaigns.id, campaignId)).limit(1);
      if (!campaign) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
      if (campaign.status !== 'draft') throw new AppError('Only a draft campaign can get a new version.', 409, 'CAMPAIGN_NOT_DRAFT');
      const derived = await this.content(db, input);
      const [latest] = await tx.select({ v: shuffleCampaignVersions.version }).from(shuffleCampaignVersions).where(eq(shuffleCampaignVersions.campaignId, campaignId)).orderBy(desc(shuffleCampaignVersions.version)).limit(1);
      const version = (latest?.v ?? 0) + 1;
      const [row] = await tx.insert(shuffleCampaignVersions).values({ campaignId, mode: campaign.mode, version, ...this.values(input, derived), createdByUserId: ctx.actorUserId }).returning();
      await this.audit(db, 'shuffle_campaign.version_created', campaignId, ctx, { versionId: row!.id, version });
      return row!;
    });
  }

  /** Controlled status moves with a recorded reason; idempotent (repeating the same target returns the campaign unchanged). */
  async setStatus(campaignId: string, target: 'suspended' | 'cancelled' | 'draft', reason: string | null, ctx: Actor) {
    const text = reason?.trim() ?? '';
    if (target !== 'draft' && (!text || text.length > 500)) throw bad('A reason of 1 to 500 characters is required.');
    return this.db.transaction(async (tx) => {
      const [c] = await tx.select().from(shuffleCampaigns).where(eq(shuffleCampaigns.id, campaignId)).for('update').limit(1);
      if (!c) throw new AppError('Campaign not found.', 404, 'CAMPAIGN_NOT_FOUND');
      if (c.status === target) return c;
      const allowed = (c.status === 'draft' && target !== 'draft') || (c.status === 'suspended' && target !== 'suspended');
      if (!allowed) throw new AppError('That campaign status change is not allowed.', 409, 'CAMPAIGN_TRANSITION_NOT_ALLOWED');
      const [row] = await tx.update(shuffleCampaigns).set({
        status: target, statusReason: target === 'draft' ? null : text, statusChangedAt: new Date(), statusChangedByUserId: ctx.actorUserId,
      }).where(eq(shuffleCampaigns.id, campaignId)).returning();
      await this.audit(tx as unknown as Db, `shuffle_campaign.${target === 'draft' ? 'resumed' : target}`, campaignId, ctx, { reason: target === 'draft' ? null : text });
      return row!;
    });
  }

  async list() {
    const campaigns = await this.db.select().from(shuffleCampaigns).orderBy(shuffleCampaigns.key);
    const versions = await this.db.select().from(shuffleCampaignVersions).orderBy(shuffleCampaignVersions.campaignId, shuffleCampaignVersions.version);
    return campaigns.map((c) => ({ ...c, versions: versions.filter((v) => v.campaignId === c.id) }));
  }

  /**
   * Records WHO IS ELIGIBLE under a version (immutable, once per customer and version). Fails closed: the referenced qualification rule must be APPROVED,
   * the campaign must be an active draft, and evidence is measured server-side inside the campaign's qualification window. It admits nobody.
   */
  async takeEligibilitySnapshot(versionId: string, customerId: string, ctx: Actor) {
    return this.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const [v] = await tx.select().from(shuffleCampaignVersions).where(eq(shuffleCampaignVersions.id, versionId)).limit(1);
      if (!v) throw new AppError('Campaign version not found.', 404, 'CAMPAIGN_NOT_FOUND');
      const [campaign] = await tx.select().from(shuffleCampaigns).where(eq(shuffleCampaigns.id, v.campaignId)).limit(1);
      if (campaign?.status !== 'draft') throw new AppError('Eligibility can only be recorded for an active campaign.', 409, 'CAMPAIGN_NOT_DRAFT');
      const [rule] = await tx.select().from(qualificationRuleVersions).where(and(eq(qualificationRuleVersions.id, v.qualificationRuleVersionId), eq(qualificationRuleVersions.approvalState, 'approved'))).limit(1);
      if (!rule) throw new AppError('No approved qualification rule backs this campaign, so eligibility cannot be recorded.', 409, 'QUALIFICATION_NOT_APPROVED');
      const result = await evaluateRuleForCustomer(db, customerId, rule, { consumerKind: 'campaign', between: { start: v.qualificationWindowStart, end: v.qualificationWindowEnd } });
      if (!result) throw new AppError('The qualification rule could not be evaluated.', 409, 'QUALIFICATION_RULE_INVALID');
      const evidence = { ruleVersionId: rule.id, specHash: rule.specHash, qualified: result.outcome.qualified, pathways: result.outcome.pathways, evidenceIds: result.evidenceIds, evidenceLevel: 'recorded' };
      const [row] = await tx.insert(shuffleEligibilitySnapshots).values({
        campaignVersionId: versionId, customerId, qualified: result.outcome.qualified, evidence, evidenceHash: sha(JSON.stringify(evidence)), ruleVersionId: rule.id,
      }).onConflictDoNothing().returning();
      if (!row) {
        const [existing] = await tx.select().from(shuffleEligibilitySnapshots).where(and(eq(shuffleEligibilitySnapshots.campaignVersionId, versionId), eq(shuffleEligibilitySnapshots.customerId, customerId))).limit(1);
        return { snapshot: existing!, created: false };
      }
      await this.audit(db, 'shuffle_campaign.eligibility_snapshot', v.campaignId, ctx, { versionId, qualified: row.qualified });
      return { snapshot: row, created: true };
    });
  }

  async snapshotCounts(versionId: string) {
    const r = await this.db.execute<{ qualified: boolean; n: number }>(sql`select qualified, count(*)::int as n from shuffle_eligibility_snapshots where campaign_version_id = ${versionId} group by qualified`);
    const rows = r.rows ?? [];
    return { qualified: Number(rows.find((x) => x.qualified)?.n ?? 0), notQualified: Number(rows.find((x) => !x.qualified)?.n ?? 0) };
  }

  private async audit(db: Db, action: string, campaignId: string, ctx: Actor, metadata: Record<string, unknown>) {
    await db.insert(auditLog).values({ businessId: null, actorUserId: ctx.actorUserId, action, entityType: 'shuffle_campaign', entityId: campaignId, metadata: { outcome: 'success', ...metadata }, ipAddress: ctx.ipAddress ?? null, userAgent: ctx.userAgent ?? null });
  }
}
