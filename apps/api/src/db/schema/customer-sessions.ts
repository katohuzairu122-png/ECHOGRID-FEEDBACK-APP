import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customers } from './customers';

export const CUSTOMER_SESSION_AUTH_METHODS = ['otp', 'password', 'recovery'] as const;
export type CustomerSessionAuthMethod = (typeof CUSTOMER_SESSION_AUTH_METHODS)[number];

export const CUSTOMER_SESSION_REVOKED_REASONS = [
  'logout',
  'logout_all',
  'password_changed',
  'recovery',
  'replay_detected',
  'suspended',
  'expired_cleanup',
  'admin',
] as const;
export type CustomerSessionRevokedReason = (typeof CUSTOMER_SESSION_REVOKED_REASONS)[number];

/**
 * CUSTOMER-AUTH-01B section 5.2: one durable row per signed-in device. `id` is
 * the `sid` claim in the customer session access token. Liveness is derived
 * from timestamps at read time (see customer-auth/session-policy.ts); no
 * cleanup job is needed for correctness.
 *
 * Deliberately NOT spread with auditColumns/softDeleteColumns: sessions expire
 * and are revoked, never hidden. `device_label` is a short derived label, never
 * a raw user agent. `source_hint` is a coarse network hint under decision D-B1
 * and may stay null.
 */
export const customerSessions = pgTable(
  'customer_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    authMethod: text('auth_method').$type<CustomerSessionAuthMethod>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
    absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp('idle_expires_at', { withTimezone: true }).notNull(),
    stepUpVerifiedAt: timestamp('step_up_verified_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason').$type<CustomerSessionRevokedReason>(),
    deviceLabel: text('device_label'),
    sourceHint: text('source_hint'),
  },
  (table) => [
    index('customer_sessions_customer_revoked_idx').on(table.customerId, table.revokedAt),
    index('customer_sessions_absolute_expires_idx').on(table.absoluteExpiresAt),
    check(
      'customer_sessions_auth_method_check',
      sql`${table.authMethod} IN ('otp', 'password', 'recovery')`,
    ),
    check(
      'customer_sessions_revoked_reason_check',
      sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('logout', 'logout_all', 'password_changed', 'recovery', 'replay_detected', 'suspended', 'expired_cleanup', 'admin')`,
    ),
    // 01B invariant I8: a reason exists if and only if the session is revoked.
    check(
      'customer_sessions_revoked_pair_check',
      sql`(${table.revokedAt} IS NULL) = (${table.revokedReason} IS NULL)`,
    ),
    check(
      'customer_sessions_device_label_length_check',
      sql`${table.deviceLabel} IS NULL OR char_length(${table.deviceLabel}) <= 80`,
    ),
    check(
      'customer_sessions_source_hint_length_check',
      sql`${table.sourceHint} IS NULL OR char_length(${table.sourceHint}) <= 64`,
    ),
  ],
);
