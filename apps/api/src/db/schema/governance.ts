import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, index, uniqueIndex, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users';
import { shuffleCampaignVersions } from './shuffle';
import { dropSponsorships } from './drops';

export const GOVERNANCE_CASE_KINDS = ['fraud', 'dispute'] as const;
export const GOVERNANCE_SUBJECT_TYPES = ['shuffle_campaign_version', 'shuffle_entry', 'shuffle_selection', 'drop_sponsorship', 'drop_reservation'] as const;
export const GOVERNANCE_CLASSIFICATIONS = ['suspected_duplicate_participation', 'suspected_fabricated_evidence', 'allocation_dispute', 'collection_dispute', 'other'] as const;
export const GOVERNANCE_CASE_STATUSES = ['open', 'escalated', 'under_review', 'decided', 'closed'] as const;
export const GOVERNANCE_DECISIONS = ['upheld', 'overturned', 'no_action'] as const;
export const GOVERNANCE_OPERATOR_ROLES = ['fraud_investigator', 'dispute_resolver'] as const;
/** The ONLY override scopes. Voiding or reassigning an allocated unit, replacing selected participants and rewriting selection evidence have NO scope: they stay blocked. */
export const GOVERNANCE_OVERRIDE_SCOPES = ['cancel_entry_before_selection', 'release_reserved_hold'] as const;
export const GOVERNANCE_OVERRIDE_STATUSES = ['requested', 'approved', 'executed', 'rejected', 'cancelled', 'expired'] as const;

/**
 * TSH-08 operator assignments. EMPTY BY DEFAULT: until the Owner assigns fraud investigators and dispute resolvers (an operational decision that is not
 * invented here), no case can be reviewed, decided or overridden. There is no route that creates a row: an assignment is a privilege grant made by the Owner.
 */
export const governanceOperators = pgTable(
  'governance_operators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('governance_operators_user_role_uq').on(t.userId, t.role), check('governance_operators_role', sql`${t.role} IN ('fraud_investigator','dispute_resolver')`)],
);

/** Synthetic-only fraud and dispute case. Related references are derived and validated by the database. Nothing here changes a campaign, entry, selection or unit by itself. */
export const governanceCases = pgTable(
  'governance_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),
    campaignVersionId: uuid('campaign_version_id').references(() => shuffleCampaignVersions.id, { onDelete: 'restrict' }),
    sponsorshipId: uuid('sponsorship_id').references(() => dropSponsorships.id, { onDelete: 'restrict' }),
    classification: text('classification').notNull(),
    summary: text('summary').notNull(),
    status: text('status').notNull().default('open'),
    openedByUserId: uuid('opened_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'restrict' }),
    relatedCaseId: uuid('related_case_id'),
    escalationReason: text('escalation_reason'),
    decision: text('decision'),
    decisionReason: text('decision_reason'),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    synthetic: boolean('synthetic').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('governance_cases_subject_idx').on(t.subjectType, t.subjectId),
    index('governance_cases_status_idx').on(t.status, t.kind),
    check('governance_cases_kind', sql`${t.kind} IN ('fraud','dispute')`),
    check('governance_cases_subject_type', sql`${t.subjectType} IN ('shuffle_campaign_version','shuffle_entry','shuffle_selection','drop_sponsorship','drop_reservation')`),
    check('governance_cases_classification', sql`${t.classification} IN ('suspected_duplicate_participation','suspected_fabricated_evidence','allocation_dispute','collection_dispute','other')`),
    check('governance_cases_status', sql`${t.status} IN ('open','escalated','under_review','decided','closed')`),
    check('governance_cases_family', sql`(${t.subjectType} LIKE 'shuffle_%' AND ${t.campaignVersionId} IS NOT NULL AND ${t.sponsorshipId} IS NULL) OR (${t.subjectType} LIKE 'drop_%' AND ${t.sponsorshipId} IS NOT NULL AND ${t.campaignVersionId} IS NULL)`),
    check('governance_cases_text', sql`char_length(${t.summary}) BETWEEN 1 AND 1000`),
    check('governance_cases_decision_shape', sql`(${t.decision} IS NULL AND ${t.decidedByUserId} IS NULL AND ${t.decidedAt} IS NULL AND ${t.decisionReason} IS NULL) OR (${t.decision} IN ('upheld','overturned','no_action') AND ${t.decidedByUserId} IS NOT NULL AND ${t.decidedAt} IS NOT NULL AND char_length(${t.decisionReason}) >= 10)`),
    check('governance_cases_synthetic', sql`${t.synthetic} = true`),
  ],
);

/** APPEND-ONLY evidence: never edited or removed; a correction is a new item that refers to the old one in its text. */
export const governanceCaseEvidence = pgTable(
  'governance_case_evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => governanceCases.id, { onDelete: 'restrict' }),
    submittedByUserId: uuid('submitted_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('governance_case_evidence_case_idx').on(t.caseId, t.createdAt),
    check('governance_case_evidence_kind', sql`${t.kind} IN ('note','reference')`),
    check('governance_case_evidence_body', sql`char_length(${t.body}) BETWEEN 1 AND 2000 AND ${t.contentHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Hash-chained append-only case log (linkage enforced by trigger; verifyChain recomputes). */
export const governanceEvents = pgTable(
  'governance_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => governanceCases.id, { onDelete: 'restrict' }),
    seq: integer('seq').notNull(),
    prevHash: text('prev_hash'),
    hash: text('hash').notNull(),
    event: jsonb('event').$type<Record<string, unknown>>().notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('governance_events_seq_uq').on(t.caseId, t.seq),
    check('governance_events_hash', sql`${t.hash} ~ '^[0-9a-f]{64}$' AND (${t.prevHash} IS NULL OR ${t.prevHash} ~ '^[0-9a-f]{64}$') AND ${t.seq} >= 1 AND ((${t.seq} = 1) = (${t.prevHash} IS NULL))`),
  ],
);

/** Two-person override: requested by one operator, approved by a DIFFERENT operator, single-use, expiring, bound to the case evidence at request time. */
export const governanceOverrides = pgTable(
  'governance_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id').notNull().references(() => governanceCases.id, { onDelete: 'restrict' }),
    scope: text('scope').notNull(),
    targetId: uuid('target_id').notNull(),
    justification: text('justification').notNull(),
    evidenceHash: text('evidence_hash').notNull(),
    status: text('status').notNull().default('requested'),
    requestedByUserId: uuid('requested_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    synthetic: boolean('synthetic').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('governance_overrides_case_idx').on(t.caseId, t.status),
    uniqueIndex('governance_overrides_open_target_uq').on(t.scope, t.targetId).where(sql`${t.status} IN ('requested','approved')`),
    check('governance_overrides_scope', sql`${t.scope} IN ('cancel_entry_before_selection','release_reserved_hold')`),
    check('governance_overrides_status', sql`${t.status} IN ('requested','approved','executed','rejected','cancelled','expired')`),
    check('governance_overrides_justification', sql`char_length(${t.justification}) BETWEEN 10 AND 1000 AND ${t.evidenceHash} ~ '^[0-9a-f]{64}$'`),
    check('governance_overrides_two_person', sql`${t.approvedByUserId} IS NULL OR ${t.approvedByUserId} <> ${t.requestedByUserId}`),
    check('governance_overrides_approval_shape', sql`(${t.status} IN ('approved','executed')) = (${t.approvedByUserId} IS NOT NULL) OR ${t.status} IN ('expired','cancelled')`),
    check('governance_overrides_synthetic', sql`${t.synthetic} = true`),
  ],
);
