import { pgTable, uuid, text, integer, timestamp, index } from 'drizzle-orm/pg-core';

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
export const otpCodes = pgTable(
  'otp_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The table's only index, and until now it had none at all -- so both
     * customer-login lookups (findLatestForPhone for the request cooldown,
     * findActiveForPhone for verification) were sequential scans, on every
     * requestOtp and every verifyOtp.
     *
     * NOT declared DESC despite both queries ordering `created_at DESC`. A
     * btree is scanned in either direction at equal cost, so (phone,
     * created_at) already serves `WHERE phone = $1 ORDER BY created_at
     * DESC LIMIT 1` as an index scan -- and avoiding the DESC modifier
     * keeps this on the plainest drizzle-kit output rather than relying on
     * its ordered-index support.
     *
     * One index, not two. A partial index on `consumed_at IS NULL` would
     * narrow findActiveForPhone slightly, but the phone equality already
     * reduces the set to a handful of rows, and a second index costs write
     * throughput on a path that writes once per SMS. The daily prune below
     * is what actually keeps this table small.
     */
    index('otp_codes_phone_created_idx').on(table.phone, table.createdAt),
  ],
);
