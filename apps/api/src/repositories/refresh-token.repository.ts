import { eq, and, isNull } from 'drizzle-orm';
import { refreshTokens } from '../db/schema';
import { BaseRepository } from './base.repository';

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

export class RefreshTokenRepository extends BaseRepository {
  async create(input: NewRefreshToken): Promise<RefreshToken> {
    const [row] = await this.db.insert(refreshTokens).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  async findById(id: string): Promise<RefreshToken | undefined> {
    return this.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.id, id) });
  }

  /** Marks a token used-and-superseded by the token issued in its place
   * (rotation), rather than a plain revoke, so the chain stays auditable. */
  async rotate(id: string, replacedByTokenId: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date(), replacedByTokenId })
      .where(eq(refreshTokens.id, id));
  }

  async revoke(id: string): Promise<void> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.id, id));
  }

  /** Active (unrevoked) sessions for a user. Expiry is a separate check the
   * caller makes against `expiresAt` -- this stays a pure "not explicitly
   * revoked" read. */
  async listActiveForUser(userId: string): Promise<RefreshToken[]> {
    return this.db.query.refreshTokens.findMany({
      where: and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)),
    });
  }

  /**
   * Revokes every unrevoked session for a user in one statement. Added for
   * the password-reset/change flows: a password change must not leave an
   * attacker's existing session alive for the remainder of its 30-day
   * refresh-token lifetime, which is exactly the window `refresh()`'s
   * account-status recheck (see docs/SECURITY-REVIEW.md) was added to close
   * for deactivation.
   *
   * `replacedByTokenId` is deliberately left NULL here, unlike rotate():
   * these sessions are being killed, not superseded by a specific successor,
   * and pointing them at an unrelated token would corrupt the rotation chain
   * that revoked-token-reuse detection reads.
   *
   * Returns the number of sessions actually revoked so the caller can log or
   * surface it ("signed out of N devices") without a second query.
   */
  async revokeAllForUser(userId: string): Promise<number> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });
    return rows.length;
  }
}
