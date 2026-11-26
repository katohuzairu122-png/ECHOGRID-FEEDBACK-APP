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

/**
 * TSH-05 (invitations, entries, notification intents) and the TSH-04 integration records. SYNTHETIC-ONLY BY CONSTRUCTION: every row carries
 * `synthetic = true` enforced by CHECK, no customer-facing route exists, and versions can never be released. Real participation therefore needs a
 * later, separately authorized migration (legal L-1..L-6, decisions D-3..D-5). An invitation is NOT a business invitation, a referral, marketing
 * consent, an entry or eligibility by itself: it is bound to one qualified snapshot of one campaign version, re-checked at every step.
 */
export const SHUFFLE_INVITATION_STATUSES = ['generated', 'viewed', 'accepted', 'declined', 'expired', 'withdrawn'] as const;
export type ShuffleInvitationStatus = (typeof SHUFFLE_INVITATION_STATUSES)[number];
export const SHUFFLE_ENTRY_STATUSES = ['accepted', 'admitted', 'rejected', 'cancelled'] as const;
export type ShuffleEntryStatus = (typeof SHUFFLE_ENTRY_STATUSES)[number];

export const shuffleInvitations = pgTable(
  'shuffle_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull(),
    campaignVersionId: uuid('campaign_version_id').notNull(),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    /** The qualified snapshot this invitation derives from: one invitation per qualification (unique). */
    snapshotId: uuid('snapshot_id').notNull().references(() => shuffleEligibilitySnapshots.id, { onDelete: 'restrict' }),
    status: text('status').$type<ShuffleInvitationStatus>().notNull().default('generated'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    synthetic: boolean('synthetic').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.campaignVersionId, t.campaignId], foreignColumns: [shuffleCampaignVersions.id, shuffleCampaignVersions.campaignId], name: 'shuffle_invitations_version_fk' }).onDelete('restrict'),
    uniqueIndex('shuffle_invitations_snapshot_uq').on(t.snapshotId),
    uniqueIndex('shuffle_invitations_version_customer_uq').on(t.campaignVersionId, t.customerId),
    unique('shuffle_invitations_id_version_customer_uq').on(t.id, t.campaignVersionId, t.customerId),
    index('shuffle_invitations_customer_idx').on(t.customerId, t.status),
    check('shuffle_invitations_status_valid', sql`${t.status} IN ('generated','viewed','accepted','declined','expired','withdrawn')`),
    check('shuffle_invitations_synthetic', sql`${t.synthetic} = true`),
  ],
);

/** Append-only transition log: who/what moved an invitation, and why. */
export const shuffleInvitationEvents = pgTable(
  'shuffle_invitation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invitationId: uuid('invitation_id').notNull().references(() => shuffleInvitations.id, { onDelete: 'restrict' }),
    fromStatus: text('from_status'),
    toStatus: text('to_status').notNull(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('shuffle_invitation_events_inv_idx').on(t.invitationId, t.createdAt), check('shuffle_invitation_events_to_valid', sql`${t.toStatus} IN ('generated','viewed','accepted','declined','expired','withdrawn')`)],
);

/**
 * A notification INTENT is an informational in-app record only. Delivery is unavailable: the state is fixed at 'held' by CHECK, the only channel is
 * in-app (no email/SMS: marketing consent policy is unresolved), and a notification never authorizes anything.
 */
export const shuffleNotificationIntents = pgTable(
  'shuffle_notification_intents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invitationId: uuid('invitation_id').notNull().references(() => shuffleInvitations.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull().default('in_app'),
    deliveryState: text('delivery_state').notNull().default('held'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('shuffle_notification_intents_once_uq').on(t.invitationId, t.channel), check('shuffle_notification_intents_held', sql`${t.deliveryState} = 'held' AND ${t.channel} = 'in_app'`)],
);

/** Accepted participation: one per invitation and per (version, customer); acceptance binds the exact terms and disclosure hash (D-4). */
export const shuffleEntries = pgTable(
  'shuffle_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    invitationId: uuid('invitation_id').notNull(),
    campaignVersionId: uuid('campaign_version_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    acceptedTermsVersion: text('accepted_terms_version').notNull(),
    acceptedDisclosureHash: text('accepted_disclosure_hash').notNull(),
    status: text('status').$type<ShuffleEntryStatus>().notNull().default('accepted'),
    statusReason: text('status_reason'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    synthetic: boolean('synthetic').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({ columns: [t.invitationId, t.campaignVersionId, t.customerId], foreignColumns: [shuffleInvitations.id, shuffleInvitations.campaignVersionId, shuffleInvitations.customerId], name: 'shuffle_entries_invitation_fk' }).onDelete('restrict'),
    uniqueIndex('shuffle_entries_invitation_uq').on(t.invitationId),
    uniqueIndex('shuffle_entries_version_customer_uq').on(t.campaignVersionId, t.customerId),
    unique('shuffle_entries_id_version_uq').on(t.id, t.campaignVersionId),
    index('shuffle_entries_version_status_idx').on(t.campaignVersionId, t.status),
    check('shuffle_entries_status_valid', sql`${t.status} IN ('accepted','admitted','rejected','cancelled')`),
    check('shuffle_entries_synthetic', sql`${t.synthetic} = true`),
    check('shuffle_entries_hash', sql`${t.acceptedDisclosureHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Hash-chained, append-only evidence log per campaign version. The database enforces contiguous sequence and linkage; verifyChain recomputes hashes. */
export const shuffleAllocationEvents = pgTable(
  'shuffle_allocation_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id').notNull().references(() => shuffleCampaignVersions.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('shuffle_allocation_events_seq_uq').on(t.campaignVersionId, t.seq),
    check('shuffle_allocation_events_seq_pos', sql`${t.seq} >= 1`),
    check('shuffle_allocation_events_hash', sql`${t.hash} ~ '^[0-9a-f]{64}$' AND (${t.prevHash} IS NULL OR ${t.prevHash} ~ '^[0-9a-f]{64}$') AND ((${t.seq} = 1) = (${t.prevHash} IS NULL))`),
  ],
);

/** One recorded SYNTHETIC selection per version: commitments, the recorded random draws (replay-verifiable) and the selected entries. Append-only. */
export const shuffleSelectionResults = pgTable(
  'shuffle_selection_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignVersionId: uuid('campaign_version_id').notNull().references(() => shuffleCampaignVersions.id, { onDelete: 'restrict' }),
    entrantCount: integer('entrant_count').notNull(),
    winnerCount: integer('winner_count').notNull(),
    selectedEntryIds: jsonb('selected_entry_ids').$type<string[]>().notNull(),
    inputCommitment: text('input_commitment').notNull(),
    resultCommitment: text('result_commitment').notNull(),
    transcript: jsonb('transcript').$type<string[]>().notNull(),
    synthetic: boolean('synthetic').notNull().default(true),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('shuffle_selection_results_version_uq').on(t.campaignVersionId),
    check('shuffle_selection_results_counts', sql`${t.winnerCount} >= 1 AND ${t.winnerCount} <= ${t.entrantCount}`),
    check('shuffle_selection_results_hashes', sql`${t.inputCommitment} ~ '^[0-9a-f]{64}$' AND ${t.resultCommitment} ~ '^[0-9a-f]{64}$'`),
    check('shuffle_selection_results_synthetic', sql`${t.synthetic} = true`),
  ],
);
