import { eq, and, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { passwordResetTokens } from '../db/schema';
import { BaseRepository } from './base.repository';

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

/**
 * Not tenant-scoped, deliberately -- a staff user is a global identity
 * (see users.ts), and a password reset happens before any business context
 * exists in the request. This mirrors RefreshTokenRepository, which is
 * global for the same reason; the "every query takes a businessId"
 * convention in base.repository.ts applies to business-owned tables, which
 * this is not.
 */
export class PasswordResetTokenRepository extends BaseRepository {
  async create(input: NewPasswordResetToken): Promise<PasswordResetToken> {
    const [row] = await this.db.insert(passwordResetTokens).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /**
   * Looks a token up by its SHA-256 hash -- the only identifier an inbound
   * redemption request carries. Returns the row whatever its state
   * (consumed, invalidated, expired); the caller decides what is still
   * usable, matching how RefreshTokenRepository.findById leaves the
   * revoked/expired decision to AuthService rather than silently filtering.
   */
  async findByTokenHash(tokenHash: string): Promise<PasswordResetToken | undefined> {
    return this.db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.tokenHash, tokenHash),
    });
  }

  /**
   * Marks a token as actually redeemed. Every lifecycle condition is checked
   * atomically against the DB row so concurrent redemption, invalidation, or
   * expiry cannot race the earlier service-layer read. Returns false when the
   * update matched nothing, which the caller treats as an invalid link.
   *
   * This is the same check-then-act fix applied to
   * `loyalty-transaction.repository.ts`'s confirmRedemption in the Phase 8
   * security review (see docs/SECURITY-REVIEW.md); the identical race exists
   * here and is worth more: losing it would let one link set a password
   * twice.
   */
  async consume(id: string): Promise<boolean> {
    const consumedAt = new Date();
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ consumedAt })
      .where(
        and(
          eq(passwordResetTokens.id, id),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
          gt(passwordResetTokens.expiresAt, consumedAt),
        ),
      )
      .returning({ id: passwordResetTokens.id });
    return rows.length > 0;
  }

  /**
   * Cancels every outstanding (unused, uncancelled) token for a user.
   * Called when a new reset is requested and again after any successful
   * password change, so a stale link in an old email can never be redeemed
   * against a password the user has since changed.
   */
  async invalidateAllForUser(userId: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
        ),
      );
  }

  /**
   * H3-5: issues a new reset token for a user UNLESS an outstanding (unused, uncancelled, unexpired) one was created within the
   * last `windowSeconds`; then it returns null and changes nothing, so the earlier link stays valid and no email is due.
   *
   * Atomic without a schema change: one transaction takes a per-user transaction-scoped advisory lock first, so concurrent
   * requests for the same user are serialised and each re-reads the other's committed row (READ COMMITTED takes a fresh snapshot
   * per statement). A bare "insert where not exists" would let two simultaneous requests both pass. The older outstanding
   * tokens are invalidated and the new one inserted in the same transaction, so there is never a moment with two live links
   * or none. The lock key is derived from the user id only; it exposes nothing and holds no row.
   */
  async issueUnlessRecent(
    input: NewPasswordResetToken,
    windowSeconds: number,
  ): Promise<PasswordResetToken | null> {
    return (this.db as Database).transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'password_reset_request:' + input.userId}, 0))`);
      const recent = await tx
        .select({ id: passwordResetTokens.id })
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.userId, input.userId),
            isNull(passwordResetTokens.consumedAt),
            isNull(passwordResetTokens.invalidatedAt),
            gt(passwordResetTokens.expiresAt, sql`now()`),
            gt(passwordResetTokens.createdAt, sql`now() - make_interval(secs => ${windowSeconds})`),
          ),
        )
        .limit(1);
      if (recent.length > 0) return null;
      await tx
        .update(passwordResetTokens)
        .set({ invalidatedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.userId, input.userId),
            isNull(passwordResetTokens.consumedAt),
            isNull(passwordResetTokens.invalidatedAt),
          ),
        );
      const [row] = await tx.insert(passwordResetTokens).values(input).returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    });
  }

  /** Cancels one token (used when its email could not be sent, so a retry is not suppressed by a link nobody received). */
  async invalidateById(id: string): Promise<void> {
    await this.db
      .update(passwordResetTokens)
      .set({ invalidatedAt: new Date() })
      .where(
        and(
          eq(passwordResetTokens.id, id),
          isNull(passwordResetTokens.consumedAt),
          isNull(passwordResetTokens.invalidatedAt),
        ),
      );
  }
}
