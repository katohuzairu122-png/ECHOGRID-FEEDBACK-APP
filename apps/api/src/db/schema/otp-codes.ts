import { pgTable, uuid, text, integer, timestamp } from 'drizzle-orm/pg-core';

/**
 * Ephemeral SMS verification artifacts -- deliberately NOT spread with
 * auditColumns/softDeleteColumns (same reasoning as `refresh_tokens`): this
 * is a short-lived security artifact, not tenant-owned business data. No FK
 * to `customers.id` -- a phone's first-ever OTP request happens before any
 * customer row exists, so the relationship would be circular.
 *
 * `codeHash` uses the same self-describing PBKDF2 format as password
 * hashes (`auth/password.ts`'s pbkdf2Hash, reused via the generic helper),
 * but at far fewer iterations (`customer-auth/otp.ts`) -- an OTP's real
 * security comes from the short `expires_at` window and `attempts` capping
 * below, not offline-hash resistance, so tuning it to password-cracking
 * iteration counts would just add per-request latency for no real benefit.
 */
export const otpCodes = pgTable('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
