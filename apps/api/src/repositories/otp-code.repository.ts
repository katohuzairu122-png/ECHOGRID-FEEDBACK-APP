import { eq, and, gt, isNull, desc, sql } from 'drizzle-orm';
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

  async markConsumed(id: string): Promise<void> {
    await this.db.update(otpCodes).set({ consumedAt: new Date() }).where(eq(otpCodes.id, id));
  }
}
