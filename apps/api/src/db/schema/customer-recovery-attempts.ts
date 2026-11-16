import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

/**
 * CUSTOMER-AUTH-S4-02. One durable recovery attempt of an email-linked customer
 * (password reset only, D4). The row IS the state machine; every timestamp that
 * decides security (hold deadline, expiry, ended_at) is written from the DATABASE
 * clock (`now()`), never from the application or a client.
 *
 *   awaiting_factors -> factors_verified (standard risk) -> completed
 *   awaiting_factors -> security_hold    (high risk)     -> completed
 *   any non-terminal -> cancelled | expired | rejected
 *
 * `security_hold` completes only when `hold_until <= now()`; a CHECK makes an
 * earlier completion impossible even for a buggy writer. Evidence of the factors
 * stays on the row (email_factor_at, phone_factor_at, code_factor_at) and is
 * never reusable: a verified-phone proof is unique per customer.
 */
export const CUSTOMER_RECOVERY_ATTEMPT_STATUSES = [
  'awaiting_factors', 'factors_verified', 'security_hold', 'cancelled', 'expired', 'completed', 'rejected',
] as const;
export type CustomerRecoveryAttemptStatus = (typeof CUSTOMER_RECOVERY_ATTEMPT_STATUSES)[number];
export const CUSTOMER_RECOVERY_NON_TERMINAL = ['awaiting_factors', 'factors_verified', 'security_hold'] as const;
export const CUSTOMER_RECOVERY_RISKS = ['standard', 'high'] as const;
export type CustomerRecoveryRisk = (typeof CUSTOMER_RECOVERY_RISKS)[number];
export const CUSTOMER_RECOVERY_RISK_REASONS = ['both_factors', 'recovery_code_path', 'recent_phone_verification'] as const;
export type CustomerRecoveryRiskReason = (typeof CUSTOMER_RECOVERY_RISK_REASONS)[number];
export const CUSTOMER_RECOVERY_ENDED_REASONS = [
  'completed', 'cancelled_by_customer', 'expired', 'superseded', 'notification_failed', 'factor_budget_exhausted',
] as const;
export type CustomerRecoveryEndedReason = (typeof CUSTOMER_RECOVERY_ENDED_REASONS)[number];
export const CUSTOMER_RECOVERY_MAX_FACTOR_FAILURES = 5;

export const customerRecoveryAttempts = pgTable('customer_recovery_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  status: text('status').$type<CustomerRecoveryAttemptStatus>().notNull().default('awaiting_factors'),
  risk: text('risk').$type<CustomerRecoveryRisk>(),
  riskReason: text('risk_reason').$type<CustomerRecoveryRiskReason>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  emailFactorAt: timestamp('email_factor_at', { withTimezone: true }),
  phoneFactorAt: timestamp('phone_factor_at', { withTimezone: true }),
  /** The verified-phone proof's own timestamp. Unique per customer: a proof can never be used twice. */
  phoneProofVerifiedAt: timestamp('phone_proof_verified_at', { withTimezone: true }),
  codeFactorAt: timestamp('code_factor_at', { withTimezone: true }),
  factorFailures: integer('factor_failures').notNull().default(0),
  /** Set only after the notifier ACCEPTED the initiation notice. Nothing proceeds without it. */
  noticeAcceptedAt: timestamp('notice_accepted_at', { withTimezone: true }),
  holdStartedAt: timestamp('hold_started_at', { withTimezone: true }),
  holdUntil: timestamp('hold_until', { withTimezone: true }),
  holdNoticeAcceptedAt: timestamp('hold_notice_accepted_at', { withTimezone: true }),
  /** HMAC digest of the single-use cancellation token. The token itself is never stored. */
  cancelDigest: text('cancel_digest').notNull(),
  cancelExpiresAt: timestamp('cancel_expires_at', { withTimezone: true }).notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endedReason: text('ended_reason').$type<CustomerRecoveryEndedReason>(),
}, (table) => [
  uniqueIndex('customer_recovery_attempts_active_customer_uidx').on(table.customerId)
    .where(sql`${table.status} IN ('awaiting_factors', 'factors_verified', 'security_hold')`),
  uniqueIndex('customer_recovery_attempts_phone_proof_uidx').on(table.customerId, table.phoneProofVerifiedAt)
    .where(sql`${table.phoneProofVerifiedAt} IS NOT NULL`),
  uniqueIndex('customer_recovery_attempts_cancel_digest_uidx').on(table.cancelDigest),
  index('customer_recovery_attempts_customer_created_idx').on(table.customerId, table.createdAt),
  check('customer_recovery_attempts_status_check', sql`${table.status} IN ('awaiting_factors', 'factors_verified', 'security_hold', 'cancelled', 'expired', 'completed', 'rejected')`),
  check('customer_recovery_attempts_risk_check', sql`${table.risk} IS NULL OR ${table.risk} IN ('standard', 'high')`),
  check('customer_recovery_attempts_risk_reason_check', sql`${table.riskReason} IS NULL OR ${table.riskReason} IN ('both_factors', 'recovery_code_path', 'recent_phone_verification')`),
  check('customer_recovery_attempts_ended_reason_check', sql`${table.endedReason} IS NULL OR ${table.endedReason} IN ('completed', 'cancelled_by_customer', 'expired', 'superseded', 'notification_failed', 'factor_budget_exhausted')`),
  check('customer_recovery_attempts_terminal_check', sql`(${table.status} IN ('cancelled', 'expired', 'completed', 'rejected')) = (${table.endedAt} IS NOT NULL)`),
  check('customer_recovery_attempts_ended_reason_presence_check', sql`(${table.endedAt} IS NULL) = (${table.endedReason} IS NULL)`),
  check('customer_recovery_attempts_failures_check', sql`${table.factorFailures} >= 0 AND ${table.factorFailures} <= 5`),
  check('customer_recovery_attempts_phone_evidence_check', sql`(${table.phoneFactorAt} IS NULL) = (${table.phoneProofVerifiedAt} IS NULL)`),
  check('customer_recovery_attempts_two_factor_check', sql`${table.status} NOT IN ('factors_verified', 'security_hold', 'completed') OR num_nonnulls(${table.emailFactorAt}, ${table.phoneFactorAt}, ${table.codeFactorAt}) >= 2`),
  check('customer_recovery_attempts_risk_required_check', sql`${table.status} NOT IN ('factors_verified', 'security_hold', 'completed') OR ${table.risk} IS NOT NULL`),
  check('customer_recovery_attempts_hold_check', sql`(${table.holdUntil} IS NULL) = (${table.holdStartedAt} IS NULL) AND (${table.holdUntil} IS NULL OR (${table.risk} = 'high' AND ${table.holdUntil} > ${table.holdStartedAt})) AND (${table.status} <> 'security_hold' OR ${table.holdUntil} IS NOT NULL)`),
  check('customer_recovery_attempts_completed_check', sql`${table.status} <> 'completed' OR (${table.noticeAcceptedAt} IS NOT NULL AND (${table.risk} = 'standard' OR (${table.holdNoticeAcceptedAt} IS NOT NULL AND ${table.endedAt} >= ${table.holdUntil})))`),
  check('customer_recovery_attempts_digest_check', sql`${table.cancelDigest} ~ '^[0-9a-f]{64}$'`),
  check('customer_recovery_attempts_expiry_check', sql`${table.expiresAt} > ${table.createdAt} AND ${table.cancelExpiresAt} > ${table.createdAt}`),
]);
