import { eq, and, isNull } from 'drizzle-orm';
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
   * Marks a token as actually redeemed. Guarded on `consumed_at IS NULL` --
   * the DB row, not a value read earlier -- so two concurrent redemptions of
   * the same link cannot both succeed. Returns false when the update matched
   * nothing, which the caller must treat as "already used."
   *
   * This is the same check-then-act fix applied to
   * `loyalty-transaction.repository.ts`'s confirmRedemption in the Phase 8
   * security review (see docs/SECURITY-REVIEW.md); the identical race exists
   * here and is worth more: losing it would let one link set a password
   * twice.
   */
  async consume(id: string): Promise<boolean> {
    const rows = await this.db
      .update(passwordResetTokens)
      .set({ consumedAt: new Date() })
      .where(and(eq(passwordResetTokens.id, id), isNull(passwordResetTokens.consumedAt)))
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
}
