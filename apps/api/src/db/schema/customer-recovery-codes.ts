import { pgTable, uuid, text, timestamp, integer, smallint, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

/** Bounded size of one recovery-code set. Enforced by position CHECK and the unique (set_id, position). */
export const CUSTOMER_RECOVERY_CODE_SET_SIZE = 8;
export const CUSTOMER_RECOVERY_CODE_MAX_FAILED_ATTEMPTS = 5;
export const CUSTOMER_RECOVERY_CODE_REVOKED_REASONS = ['rotated', 'customer_revoked', 'security'] as const;
export type CustomerRecoveryCodeRevokedReason = (typeof CUSTOMER_RECOVERY_CODE_REVOKED_REASONS)[number];

/**
 * CUSTOMER-AUTH-S4-01. One generation of recovery codes. At most ONE set per
 * customer is active (revoked_at IS NULL), enforced by a partial unique index,
 * so rotation is "revoke the old set and insert the new one" in one transaction
 * and two concurrent issuances cannot both win.
 *
 * `failed_attempts` / `attempts_window_started_at` are the redemption attempt
 * budget for the set. Never stores plaintext codes.
 */
export const customerRecoveryCodeSets = pgTable('customer_recovery_code_sets', {
  id: uuid('id').primaryKey().defaultRandom(),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // No FK: an event-like reference that must outlive its session.
  createdSessionId: uuid('created_session_id'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason').$type<CustomerRecoveryCodeRevokedReason>(),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  attemptsWindowStartedAt: timestamp('attempts_window_started_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('customer_recovery_code_sets_active_customer_uidx').on(table.customerId).where(sql`${table.revokedAt} IS NULL`),
  index('customer_recovery_code_sets_customer_created_idx').on(table.customerId, table.createdAt),
  check('customer_recovery_code_sets_revoked_check', sql`(${table.revokedAt} IS NULL) = (${table.revokedReason} IS NULL)`),
  check('customer_recovery_code_sets_reason_check', sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('rotated', 'customer_revoked', 'security')`),
  check('customer_recovery_code_sets_attempts_check', sql`${table.failedAttempts} >= 0 AND ${table.failedAttempts} <= 5`),
]);

/**
 * One row per code. `verifier` is a keyed HMAC-SHA-256 of the normalized code
 * bound to the customer id (see customer-recovery-code.ts); the code itself is
 * never stored. `customer_id` is repeated so a verifier can never match across
 * customers even if a set id were substituted.
 */
export const customerRecoveryCodes = pgTable('customer_recovery_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  setId: uuid('set_id').notNull().references(() => customerRecoveryCodeSets.id, { onDelete: 'cascade' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'cascade' }),
  position: smallint('position').notNull(),
  verifier: text('verifier').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('customer_recovery_codes_set_position_uidx').on(table.setId, table.position),
  uniqueIndex('customer_recovery_codes_customer_verifier_uidx').on(table.customerId, table.verifier),
  check('customer_recovery_codes_position_check', sql`${table.position} BETWEEN 1 AND 8`),
  check('customer_recovery_codes_verifier_check', sql`${table.verifier} ~ '^[0-9a-f]{64}$'`),
  check('customer_recovery_codes_consumption_check', sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`),
]);
