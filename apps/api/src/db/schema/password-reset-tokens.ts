import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One row per issued staff password-reset token (hashed, never stored raw).
 * Deliberately NOT spread with auditColumns/softDeleteColumns -- same
 * reasoning as `refresh_tokens` and `otp_codes`: a short-lived security
 * artifact, not tenant-owned business data.
 *
 * Modeled on `refresh_tokens` rather than `otp_codes`, despite being closer
 * to OTP in purpose, because of how the secret is hashed. `otp_codes` uses
 * PBKDF2 (its 6-digit code is low-entropy and brute-forceable offline);
 * this table's token is 32 random bytes, so a plain SHA-256 via
 * `auth/token-hash.ts` is correct here for exactly the reason documented
 * there -- there is no dictionary attack to slow down, the hash only needs
 * to stop a stolen database dump from handing out live reset links. Reusing
 * the 600k-iteration password hasher for a 256-bit random value would add
 * real latency for no security gain.
 *
 * No `attempts` column, unlike `otp_codes`: an attempt cap exists to protect
 * a guessable 6-digit code. A 256-bit token needs no such protection, and an
 * attempt counter would be dead weight the reset flow has to maintain.
 *
 * FK cascades on user delete, matching `refresh_tokens` -- if the account is
 * gone, an outstanding reset link for it must not survive.
 */
export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set the moment the token is successfully redeemed -- single use.
     * Distinct from `invalidatedAt` below: this records "was actually used
     * to change a password," which is the audit-relevant event. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    /** Set when a token is superseded without being used -- a newer reset
     * was requested, or the password changed by another route. Kept separate
     * from `consumedAt` so "user redeemed a link" and "we cancelled a link"
     * stay distinguishable when reconstructing an account-recovery incident,
     * the same reasoning `refresh_tokens` uses for revokedAt vs.
     * replacedByTokenId. */
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Supports both the per-user invalidation sweep (issue a new token ->
    // cancel this user's outstanding ones) and any future "recent reset
    // activity" lookup.
    index('password_reset_tokens_user_id_idx').on(table.userId),
    // Redemption looks a token up by its hash, not by user -- that is the
    // only identifier the inbound request carries.
    index('password_reset_tokens_token_hash_idx').on(table.tokenHash),
  ],
);
