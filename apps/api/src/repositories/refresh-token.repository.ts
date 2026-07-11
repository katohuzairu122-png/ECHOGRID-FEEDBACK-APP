import { eq, and, isNull } from 'drizzle-orm';
import { refreshTokens } from '../db/schema';
import { BaseRepository } from './base.repository';

export type RefreshToken = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;

export class RefreshTokenRepository extends BaseRepository {
  async create(input: NewRefreshToken): Promise<RefreshToken> {
    const [row] = await this.db.insert(refreshTokens).values(input).returning();
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
}
