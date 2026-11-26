import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, index, uniqueIndex, unique, check, foreignKey } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';
import { users } from './users';
import { qualificationRuleVersions } from './qualification';

export const SHUFFLE_MODES = ['guaranteed', 'limited'] as const;
export type ShuffleMode = (typeof SHUFFLE_MODES)[number];
export const SHUFFLE_CAMPAIGN_STATUSES = ['draft', 'suspended', 'cancelled'] as const;
export type ShuffleCampaignStatus = (typeof SHUFFLE_CAMPAIGN_STATUSES)[number];

/**
 * TSH-03 (Tentaship Shuffle campaign foundation). CONFIGURATION AND EVIDENCE ONLY: no participation, no invitation, no selection, no allocation and no
 * reward exists in this block, and there is NO publication path: every version is `release_state = 'not_released'` (a CHECK that only a later,
 * separately approved migration can widen), because Shuffle is legally gated (TSH-01 section 2, L-1..L-6). The mode (D-3) is fixed per campaign and
 * cannot change; limits are required per campaign (D-6) and never defaulted.
 */
export const shuffleCampaigns = pgTable(
  'shuffle_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    mode: text('mode').$type<ShuffleMode>().notNull(),
    status: text('status').$type<ShuffleCampaignStatus>().notNull().default('draft'),
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedByUserId: uuid('status_changed_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shuffle_campaigns_key_uq').on(t.key),
    unique('shuffle_campaigns_id_mode_uq').on(t.id, t.mode),
    check('shuffle_campaigns_key_format', sql`${t.key} ~ '^[a-z][a-z0-9_]{2,63}$'`),
    check('shuffle_campaigns_mode_valid', sql`${t.mode} IN ('guaranteed','limited')`),
    check('shuffle_campaigns_status_valid', sql`${t.status} IN ('draft','suspended','cancelled')`),
    check('shuffle_campaigns_status_shape', sql`(${t.status} = 'draft' AND ${t.statusReason} IS NULL) OR (${t.status} <> 'draft' AND ${t.statusReason} IS NOT NULL AND ${t.statusChangedAt} IS NOT NULL AND ${t.statusChangedByUserId} IS NOT NULL)`),
  ],
);

/** IMMUTABLE campaign configuration version (D-3, D-4, D-6). A change is a new version; nothing here can be edited after insert. */
export const shuffleCampaignVersions = pgTable(
  'shuffle_campaign_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull(),
    mode: text('mode').$type<ShuffleMode>().notNull(),
    version: integer('version').notNull(),
    /** The APPROVED-at-use shared qualification rule version that defines eligibility (one engine; no second rule store). */
    qualificationRuleVersionId: uuid('qualification_rule_version_id').notNull().references(() => qualificationRuleVersions.id, { onDelete: 'restrict' }),
    /** D-6: per-campaign limits, always supplied by an administrator, never defaulted by code. */
    minParticipants: integer('min_participants').notNull(),
    maxCapacity: integer('max_capacity').notNull(),
    qualificationWindowStart: timestamp('qualification_window_start', { withTimezone: true }).notNull(),
    qualificationWindowEnd: timestamp('qualification_window_end', { withTimezone: true }).notNull(),
    entryAcceptanceDeadline: timestamp('entry_acceptance_deadline', { withTimezone: true }).notNull(),
    /** D-4: how the outcome is determined and when, disclosed BEFORE acceptance. Hashed so what a participant accepted can be proven. */
    disclosure: jsonb('disclosure').$type<Record<string, string>>().notNull(),
    disclosureHash: text('disclosure_hash').notNull(),
    termsVersion: text('terms_version').notNull(),
    closureConditions: text('closure_conditions').notNull(),
    cancellationConditions: text('cancellation_conditions').notNull(),
    contentHash: text('content_hash').notNull(),
    /** No publication path exists: a later approved migration may widen this CHECK. */
    releaseState: text('release_state').notNull().default('not_released'),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The version's mode IS its campaign's mode (D-3): enforced by the database, so a mode can never differ from the campaign or change.
    foreignKey({ columns: [t.campaignId, t.mode], foreignColumns: [shuffleCampaigns.id, shuffleCampaigns.mode], name: 'shuffle_versions_campaign_mode_fk' }).onDelete('restrict'),
    unique('shuffle_campaign_versions_campaign_version_uq').on(t.campaignId, t.version),
    unique('shuffle_campaign_versions_id_campaign_uq').on(t.id, t.campaignId),
    index('shuffle_campaign_versions_campaign_idx').on(t.campaignId, t.version),
    check('shuffle_versions_limits', sql`${t.minParticipants} >= 1 AND ${t.maxCapacity} >= ${t.minParticipants}`),
    check('shuffle_versions_window', sql`${t.qualificationWindowEnd} > ${t.qualificationWindowStart} AND ${t.entryAcceptanceDeadline} > ${t.qualificationWindowStart}`),
    check('shuffle_versions_hashes', sql`${t.disclosureHash} ~ '^[0-9a-f]{64}$' AND ${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('shuffle_versions_text', sql`char_length(${t.termsVersion}) BETWEEN 1 AND 64 AND char_length(${t.closureConditions}) BETWEEN 1 AND 1000 AND char_length(${t.cancellationConditions}) BETWEEN 1 AND 1000`),
    check('shuffle_versions_disclosure_en', sql`jsonb_typeof(${t.disclosure}) = 'object' AND ${t.disclosure} ? 'en'`),
    check('shuffle_versions_not_released', sql`${t.releaseState} = 'not_released'`),
    check('shuffle_versions_version_positive', sql`${t.version} >= 1`),
  ],
);

/**
 * Immutable record of who was ELIGIBLE under a version at a moment (TSH-01 section 3): the outcome of the shared engine over server-measured
 * evidence, with its hash. A snapshot admits nobody: there is no entry, invitation or participation in this block.
 */
export const shuffleEligibilitySnapshots = pgTable(
  'shuffle_eligibility_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id').notNull(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    qualified: boolean('qualified').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    ruleVersionId: uuid('rule_version_id').notNull().references(() => qualificationRuleVersions.id, { onDelete: 'restrict' }),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.campaignVersionId], foreignColumns: [shuffleCampaignVersions.id], name: 'shuffle_snapshots_version_fk' }).onDelete('restrict'),
    uniqueIndex('shuffle_snapshots_once_uq').on(t.campaignVersionId, t.customerId),
    index('shuffle_snapshots_version_idx').on(t.campaignVersionId, t.qualified),
    check('shuffle_snapshots_hash', sql`${t.evidenceHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
