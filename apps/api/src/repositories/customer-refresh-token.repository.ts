import { and, eq, isNull, lt } from 'drizzle-orm';
import { customerRefreshTokens, customerSessions } from '../db/schema';
import { BaseRepository } from './base.repository';

export type CustomerRefreshToken = typeof customerRefreshTokens.$inferSelect;

export type ExchangeResult =
  { rotated: true; successor: CustomerRefreshToken } | { rotated: false };

/**
 * CUSTOMER-AUTH-01B section 5.3. Stores only the SHA-256 hash of each refresh
 * credential (customer-auth/session-tokens.ts). Callers pass hashes; raw
 * credentials never reach this class. Not wired to any route yet (01D-2).
 */
export class CustomerRefreshTokenRepository extends BaseRepository {
  async issue(input: {
    sessionId: string;
    tokenHash: string;
    expiresAt: Date;
    now: Date;
  }): Promise<CustomerRefreshToken> {
    const [row] = await this.db
      .insert(customerRefreshTokens)
      .values({
        sessionId: input.sessionId,
        tokenHash: input.tokenHash,
        issuedAt: input.now,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findByHash(tokenHash: string): Promise<CustomerRefreshToken | undefined> {
    return this.db.query.customerRefreshTokens.findFirst({
      where: eq(customerRefreshTokens.tokenHash, tokenHash),
    });
  }

  /**
   * Exchanges a token for its successor, at most once (01B invariant I3). The
   * guard `rotated_at IS NULL AND revoked_at IS NULL` is evaluated by Postgres
   * against the committed row, so of two concurrent exchanges exactly one
   * wins; the loser gets `{ rotated: false }` and inserts nothing. The
   * successor is created in the same transaction, so a failure never leaves a
   * half-rotated chain. Lock the owning session BEFORE updating any refresh
   * token, matching CustomerSessionRepository.revoke's session-first lock order.
   * This prevents a refresh/revoke race leaving a new unrevoked successor after
   * its session is revoked. This is still a storage guard: the owning service
   * must verify customer status, caller authority, and replay policy.
   */
  async exchange(input: {
    oldTokenId: string;
    successor: { tokenHash: string; expiresAt: Date };
    now: Date;
  }): Promise<ExchangeResult> {
    return this.db.transaction(async (tx) => {
      // Resolve the owner without first taking a token row lock. The subsequent
      // guarded UPDATE still determines whether the predecessor is unused.
      const [predecessor] = await tx
        .select({ sessionId: customerRefreshTokens.sessionId })
        .from(customerRefreshTokens)
        .where(eq(customerRefreshTokens.id, input.oldTokenId))
        .limit(1);
      if (!predecessor) return { rotated: false } as const;

      // Revocation takes this same session lock before touching its tokens.
      // Whichever operation wins, the final committed state cannot contain a
      // usable successor after revocation.
      const [session] = await tx
        .select({
          revokedAt: customerSessions.revokedAt,
          absoluteExpiresAt: customerSessions.absoluteExpiresAt,
          idleExpiresAt: customerSessions.idleExpiresAt,
        })
        .from(customerSessions)
        .where(eq(customerSessions.id, predecessor.sessionId))
        .for('update');
      if (
        !session ||
        session.revokedAt !== null ||
        input.now.getTime() >= session.absoluteExpiresAt.getTime() ||
        input.now.getTime() >= session.idleExpiresAt.getTime()
      ) {
        return { rotated: false } as const;
      }

      const claimed = await tx
        .update(customerRefreshTokens)
        .set({ rotatedAt: input.now })
        .where(
          and(
            eq(customerRefreshTokens.id, input.oldTokenId),
            isNull(customerRefreshTokens.rotatedAt),
            isNull(customerRefreshTokens.revokedAt),
          ),
        )
        .returning({ id: customerRefreshTokens.id, sessionId: customerRefreshTokens.sessionId });
      const old = claimed[0];
      if (!old) return { rotated: false } as const;

      const [successor] = await tx
        .insert(customerRefreshTokens)
        .values({
          sessionId: old.sessionId,
          tokenHash: input.successor.tokenHash,
          issuedAt: input.now,
          expiresAt: input.successor.expiresAt,
        })
        .returning();
      if (!successor) throw new Error('Insert returned no row');

      await tx
        .update(customerRefreshTokens)
        .set({ replacedByTokenId: successor.id })
        .where(eq(customerRefreshTokens.id, old.id));
      return { rotated: true, successor } as const;
    });
  }

  /** Removes tokens that expired before `cutoff`. Space reclamation only. */
  async deleteExpiredBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(customerRefreshTokens)
      .where(lt(customerRefreshTokens.expiresAt, cutoff))
      .returning({ id: customerRefreshTokens.id });
    return rows.length;
  }
}
