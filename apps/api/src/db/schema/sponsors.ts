import { pgTable, uuid, text, integer, timestamp, jsonb, boolean, index, uniqueIndex, unique, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { businesses } from './businesses';
import { users } from './users';

export const SPONSOR_APPLICATION_STATUSES = ['submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'suspended', 'revoked'] as const;
export type SponsorApplicationStatus = (typeof SPONSOR_APPLICATION_STATUSES)[number];

/**
 * G6 sponsor application. A business asks to sponsor Tentaship Drops; a platform reviewer (a different person from the submitter) decides. SYNTHETIC ONLY (CHECK): no real sponsor is
 * approved by this block. Approval is a precondition the database enforces before a sponsorship can be scheduled/opened and before a NEW reservation (suspension stops new reservations;
 * allocated units stay honoured). Revocation is final. Identity binding is the business foreign key plus the active-business/no-closure-request assessment recorded at submission; no
 * payment, price or obligation field exists (Drops is payment-free by design).
 */
export const sponsorApplications = pgTable(
  'sponsor_applications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    submittedByUserId: uuid('submitted_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    statement: text('statement').notNull(),
    eligibilityAssessment: jsonb('eligibility_assessment').$type<Record<string, boolean>>().notNull(),
    status: text('status').$type<SponsorApplicationStatus>().notNull().default('submitted'),
    statusReason: text('status_reason'),
    reviewerUserId: uuid('reviewer_user_id').references(() => users.id, { onDelete: 'restrict' }),
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
    synthetic: boolean('synthetic').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // one live application per business (a rejected, withdrawn or revoked one is history)
    uniqueIndex('sponsor_applications_one_live_uq').on(t.businessId).where(sql`${t.status} IN ('submitted','under_review','approved','suspended')`),
    index('sponsor_applications_status_idx').on(t.status),
    check('sponsor_applications_status', sql`${t.status} IN ('submitted','under_review','approved','rejected','withdrawn','suspended','revoked')`),
    check('sponsor_applications_statement', sql`char_length(${t.statement}) BETWEEN 1 AND 2000`),
    check('sponsor_applications_synthetic', sql`${t.synthetic} = true`),
  ],
);

/** Append-only application audit trail. */
export const sponsorApplicationEvents = pgTable(
  'sponsor_application_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    applicationId: uuid('application_id').notNull().references(() => sponsorApplications.id, { onDelete: 'restrict' }),
    eventType: text('event_type').notNull(),
    actorUserId: uuid('actor_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sponsor_application_events_app_idx').on(t.applicationId, t.createdAt)],
);

export const FULFILMENT_VERIFICATION_MODES = ['staff_confirmation', 'collection_code'] as const;
export const FULFILMENT_POLICY_STATES = ['draft', 'approved', 'retired'] as const;

/**
 * G6 versioned fulfilment policy (immutable per version, approved by a DIFFERENT person, one approved at a time). STRUCTURAL parameters only: how collection is verified and an OPTIONAL
 * escalation age in hours. No SLA value is invented: an escalation age exists only if the Owner supplies it in an approved version. EMPTY in production until the Owner approves one;
 * without an approved policy the escalation and collection-policy interfaces report `available: false`.
 */
export const dropFulfilmentPolicies = pgTable(
  'drop_fulfilment_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    policyKey: text('policy_key').notNull(),
    version: integer('version').notNull(),
    parameters: jsonb('parameters').$type<Record<string, unknown>>().notNull(),
    parametersHash: text('parameters_hash').notNull(),
    approvalState: text('approval_state').notNull().default('draft'),
    createdByUserId: uuid('created_by_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id, { onDelete: 'restrict' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('drop_fulfilment_policies_version_uq').on(t.policyKey, t.version),
    uniqueIndex('drop_fulfilment_policies_one_approved_uq').on(sql`(true)`).where(sql`${t.approvalState} = 'approved'`),
    check('drop_fulfilment_policies_state', sql`${t.approvalState} IN ('draft','approved','retired')`),
    check('drop_fulfilment_policies_hash', sql`${t.parametersHash} ~ '^[0-9a-f]{64}$' AND ${t.version} >= 1`),
    check('drop_fulfilment_policies_params', sql`jsonb_typeof(${t.parameters}) = 'object' AND ${t.parameters}->>'collectionVerification' IN ('staff_confirmation','collection_code')
      AND (NOT (${t.parameters} ? 'escalateAfterHours') OR (jsonb_typeof(${t.parameters}->'escalateAfterHours') = 'number' AND (${t.parameters}->>'escalateAfterHours')::numeric > 0))`),
    check('drop_fulfilment_policies_approval_shape', sql`(${t.approvalState} = 'draft' AND ${t.approvedByUserId} IS NULL AND ${t.approvedAt} IS NULL AND ${t.retiredAt} IS NULL)
      OR (${t.approvalState} = 'approved' AND ${t.approvedByUserId} IS NOT NULL AND ${t.approvedByUserId} <> ${t.createdByUserId} AND ${t.approvedAt} IS NOT NULL AND ${t.retiredAt} IS NULL)
      OR (${t.approvalState} = 'retired' AND ${t.retiredAt} IS NOT NULL)`),
  ],
);
