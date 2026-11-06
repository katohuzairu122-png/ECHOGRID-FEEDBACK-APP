import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * One row per issued refresh token (hashed, never stored raw). Rotation on
 * every /auth/refresh call sets revokedAt + replacedByTokenId on the old row
 * instead of deleting it, so a stolen-and-replayed old token is detectable
 * (it will be found already revoked) and the chain stays auditable.
 * replacedByTokenId has no FK constraint, consistent with the audit-pointer
 * columns in _shared.ts -- it is a trail marker, not a relation that needs
 * enforcing.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /**
     * DEV-11-R1: durable SESSION identity, carried unchanged through every rotation of this session's refresh token and embedded (signed) in the access token's `sid` claim. A session is live
     * exactly while at least one of its rows is unrevoked and unexpired. NULL on rows created before the binding existed (legacy): a legacy session gets its id at its next refresh, and a legacy access
     * token (no `sid`) never authorizes privileged administrative functions.
     */
    sessionId: uuid('session_id'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByTokenId: uuid('replaced_by_token_id'),
    userAgent: text('user_agent'),
    ipAddress: text('ip_address'),
  },
  (table) => [
    index('refresh_tokens_user_id_idx').on(table.userId),
    index('refresh_tokens_session_idx').on(table.userId, table.sessionId),
  ],
);
