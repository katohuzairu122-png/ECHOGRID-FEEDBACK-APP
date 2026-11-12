import { pgTable, uuid, text, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { customerSessions } from './customer-sessions';

/**
 * CUSTOMER-AUTH-01B section 5.3: the rotating refresh-credential chain for one
 * customer session. Only the SHA-256 hash of a 256-bit random credential is
 * stored (customer-auth/session-tokens.ts), never the credential itself.
 *
 * `token_hash` is UNIQUE (unlike the staff table, whose index is not) so a
 * hash identifies exactly one row. `replaced_by_token_id` has no FK on purpose,
 * same trail-marker convention as `refresh_tokens`. `rotated_at` drives the
 * concurrent-refresh grace window: a token is exchanged at most once, by a
 * guarded `UPDATE ... WHERE rotated_at IS NULL` in the repository.
 *
 * Not spread with auditColumns/softDeleteColumns, same reasoning as the other
 * short-lived security artifacts.
 */
export const customerRefreshTokens = pgTable(
  'customer_refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => customerSessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    replacedByTokenId: uuid('replaced_by_token_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('customer_refresh_tokens_token_hash_key').on(table.tokenHash),
    index('customer_refresh_tokens_session_idx').on(table.sessionId),
    index('customer_refresh_tokens_expires_idx').on(table.expiresAt),
    // SHA-256 hex, as produced by auth/token-hash.ts. Stops a raw credential
    // or any other value from being stored by mistake (01B invariant I10).
    check('customer_refresh_tokens_hash_shape_check', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
  ],
);
