import { eq, and, gt, lt, isNull, desc, sql } from 'drizzle-orm';
import { otpCodes } from '../db/schema';
import { BaseRepository } from './base.repository';

export type OtpCode = typeof otpCodes.$inferSelect;
export type NewOtpCode = typeof otpCodes.$inferInsert;

export class OtpCodeRepository extends BaseRepository {
  async create(input: NewOtpCode): Promise<OtpCode> {
    const [row] = await this.db.insert(otpCodes).values(input).returning();
    if (!row) throw new Error('Insert returned no row');
    return row;
  }

  /** Most recent request for this phone, consumed or not -- used for the
   * per-phone request cooldown check (customer-auth/otp.ts), independent
   * of whether that code was ever successfully verified. */
  async findLatestForPhone(phone: string): Promise<OtpCode | undefined> {
    return this.db.query.otpCodes.findFirst({
      where: eq(otpCodes.phone, phone),
      orderBy: desc(otpCodes.createdAt),
    });
  }

  /** The active, verifiable code for a phone -- not yet consumed, not yet
   * expired. Used by verifyOtp; a phone can have multiple otp_codes rows
   * over time (one per request), only the newest active one is valid. */
  async findActiveForPhone(phone: string): Promise<OtpCode | undefined> {
    return this.db.query.otpCodes.findFirst({
      where: and(eq(otpCodes.phone, phone), isNull(otpCodes.consumedAt), gt(otpCodes.expiresAt, new Date())),
      orderBy: desc(otpCodes.createdAt),
    });
  }

  /** Drizzle's sql`` expression, not a read-modify-write -- avoids a
   * lost-update race between two concurrent verify attempts for the same
   * code (both incrementing from a stale in-memory count would otherwise
   * under-count real attempts, weakening the brute-force cap). */
  async incrementAttempts(id: string): Promise<void> {
    await this.db
      .update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, id));
  }

  /**
   * Marks a code as actually used. Guarded on `consumed_at IS NULL` -- the
   * DB row, not a value read earlier -- so two concurrent verifications of
   * the same code cannot both succeed. Returns false when the update matched
   * nothing, which the caller must treat as "already used".
   *
   * This is the same check-then-act fix `password-reset-token.repository.ts`
   * applies to its own `consume`, and that method's comment names this one
   * explicitly as having "the identical race". It did, for as long as this
   * was an unguarded update: findActiveForPhone read the row, the caller
   * verified the code, and nothing stopped a second concurrent request
   * doing the same between those two steps -- both then got a customer
   * session from one SMS code.
   */
  async markConsumed(id: string): Promise<boolean> {
    const rows = await this.db
      .update(otpCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(otpCodes.id, id), isNull(otpCodes.consumedAt)))
      .returning({ id: otpCodes.id });
    return rows.length > 0;
  }

  /**
   * Deletes rows created before `cutoff`. Returns how many.
   *
   * THE FIRST HARD DELETE IN THIS CODEBASE, deliberately. Every other table
   * soft-deletes, and this one cannot: the schema spreads neither
   * auditColumns nor softDeleteColumns, by the design its own comment gives
   * -- these are "ephemeral SMS verification artifacts", not tenant-owned
   * business data. There is no `is_deleted` column to set, and adding one
   * would keep forever exactly what needs to stop existing.
   *
   * Without this the table grew one row per OTP request, permanently, with
   * no delete path anywhere in src/. That is unbounded growth on the
   * customer-login hot path.
   *
   * The predicate is `created_at < cutoff` alone -- no check that a row is
   * consumed or expired -- because at any cutoff beyond OTP_EXPIRY_MINUTES
   * (10) such a check is redundant: a row created days ago cannot still be
   * verifiable. Stating the condition in terms of one column keeps it
   * obviously correct, and the caller's retention window is what guarantees
   * the premise.
   *
   * Unindexed on `created_at` by design. This runs once a day with nothing
   * waiting on it, and after its first run the table only ever holds the
   * retention window's worth of rows -- so a scan is cheap. A second index
   * to serve one daily query would tax every SMS write instead.
   */
  async deleteCreatedBefore(cutoff: Date): Promise<number> {
    const rows = await this.db
      .delete(otpCodes)
      .where(lt(otpCodes.createdAt, cutoff))
      .returning({ id: otpCodes.id });
    return rows.length;
  }
}
