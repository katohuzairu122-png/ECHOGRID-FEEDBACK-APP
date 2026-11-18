import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, boolean, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { auditLog } from './audit-log';
import { businessCustomerMemberships } from './business-customer-memberships';
import { branches } from './branches';
import { businesses } from './businesses';
import { consentGrants } from './consent-grants';
import { customers } from './customers';
import { users } from './users';

/**
 * Where an onboarding came from. Only sources that a real, authoritative enrollment workflow writes are listed:
 *  - business_qr: the customer scanned a branch's business QR and joined themselves (self-service).
 *  - cashier_assisted: a cashier at a counter issued a one-time invitation that the customer then accepted with their own consent.
 *  - remote_invitation: RESERVED. No workflow writes it yet (no authoritative remote-invitation enrollment exists); it is in the
 *    vocabulary so adding that workflow later needs no change to the CHECK, and a test proves nothing writes it today.
 */
export const ONBOARDING_SOURCES = ['business_qr', 'cashier_assisted', 'remote_invitation'] as const;
export type OnboardingSource = (typeof ONBOARDING_SOURCES)[number];

/**
 * The contact-verification facts that were TRUE when the onboarding happened, read from authoritative records
 * (customers.phone_verified_at, customer_credentials.login_email_verified_at). Enrollment never implies verification, and a
 * later verification does not rewrite the event: the customer's current state lives in those records.
 */
export const ONBOARDING_VERIFICATION_STATES = ['unverified', 'phone_verified', 'email_verified', 'phone_and_email_verified'] as const;
export type OnboardingVerificationState = (typeof ONBOARDING_VERIFICATION_STATES)[number];

/**
 * CASHIER-AUTH-02D: append-only record of each time a customer BECAME a member of a business (first join, or re-join after
 * leaving). business_customer_memberships stays the single current-relationship summary; this table is the history, so a
 * re-join adds a row instead of overwriting the original branch or cashier. Never updated, never deleted (database guard);
 * historical memberships created before this table have NO row, deliberately: attribution is never invented.
 *
 * Foreign keys are RESTRICT, not CASCADE: an append-only history must not disappear as a side effect of another delete.
 * No erasure flow exists today (docs/OPERATIONS.md); if one is introduced, it must decide how this table is handled.
 */
export const customerOnboardingEvents = pgTable(
  'customer_onboarding_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    membershipId: uuid('membership_id').notNull().references(() => businessCustomerMemberships.id, { onDelete: 'restrict' }),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
    /** NULL when no physical branch was involved or none could be established reliably. Never guessed. */
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    /** The cashier who issued the invitation; only for cashier_assisted. Never chosen by a client. */
    cashierUserId: uuid('cashier_user_id').references(() => users.id, { onDelete: 'restrict' }),
    source: text('source').$type<OnboardingSource>().notNull(),
    verificationState: text('verification_state').$type<OnboardingVerificationState>().notNull(),
    consentGrantId: uuid('consent_grant_id').references(() => consentGrants.id, { onDelete: 'restrict' }),
    /** The QR code id (business_qr) or the one-time invitation id (cashier_assisted). */
    reference: text('reference'),
    /** True when this onboarding brought back a membership that already existed (left earlier). Recorded as a fact, not inferred from history. */
    isRejoin: boolean('is_rejoin').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    auditLogId: uuid('audit_log_id').references(() => auditLog.id, { onDelete: 'restrict' }),
  },
  (table) => [
    index('customer_onboarding_events_business_occurred_idx').on(table.businessId, table.occurredAt),
    index('customer_onboarding_events_business_branch_idx').on(table.businessId, table.branchId, table.occurredAt),
    index('customer_onboarding_events_business_cashier_idx').on(table.businessId, table.cashierUserId, table.occurredAt),
    index('customer_onboarding_events_membership_idx').on(table.membershipId, table.occurredAt),
    index('customer_onboarding_events_customer_idx').on(table.customerId),
    // A one-time invitation can onboard exactly one customer: the database refuses a second use (a shared or replayed code).
    uniqueIndex('customer_onboarding_events_invite_once_key')
      .on(table.businessId, table.reference)
      .where(sql`${table.source} = 'cashier_assisted'`),
    check('customer_onboarding_events_source_check', sql`${table.source} IN ('business_qr','cashier_assisted','remote_invitation')`),
    check(
      'customer_onboarding_events_verification_check',
      sql`${table.verificationState} IN ('unverified','phone_verified','email_verified','phone_and_email_verified')`,
    ),
    // Attribution shape: a cashier is recorded exactly when the onboarding was cashier-assisted, and that always has a branch.
    check(
      'customer_onboarding_events_cashier_shape_check',
      sql`(${table.source} = 'cashier_assisted') = (${table.cashierUserId} IS NOT NULL)`,
    ),
    check(
      'customer_onboarding_events_assisted_branch_check',
      sql`${table.source} <> 'cashier_assisted' OR ${table.branchId} IS NOT NULL`,
    ),
    check(
      'customer_onboarding_events_assisted_reference_check',
      sql`${table.source} <> 'cashier_assisted' OR ${table.reference} IS NOT NULL`,
    ),
  ],
);

export type CustomerOnboardingEvent = typeof customerOnboardingEvents.$inferSelect;
export type NewCustomerOnboardingEvent = typeof customerOnboardingEvents.$inferInsert;
