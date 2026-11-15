import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { customerAuthChallenges } from '../db/schema';
import { BaseRepository } from './base.repository';
import type { CustomerAuthChallengePurpose } from '../db/schema/customer-auth-challenges';

/**
 * S1 persistence only. Caller must verify ownership and hash the proof and
 * normalized contact with domain-separated digests before calling this class.
 * Do not expose challenge records through customer/business read models.
 */
export class CustomerAuthChallengeRepository extends BaseRepository {
  async create(input: {
    customerId?: string | null;
    purpose: CustomerAuthChallengePurpose;
    subjectDigest: string;
    proofDigest: string;
    expiresAt: Date;
    now: Date;
  }): Promise<string> {
    const [row] = await this.db.insert(customerAuthChallenges).values({
      customerId: input.customerId ?? null,
      purpose: input.purpose,
      subjectDigest: input.subjectDigest,
      proofDigest: input.proofDigest,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    }).returning({ id: customerAuthChallenges.id });
    if (!row) throw new Error('Challenge insert returned no row');
    return row.id;
  }

  /**
   * A single conditional UPDATE is the linearization point: only one
   * concurrent consumer can observe an unconsumed, unexpired proof.
   * All identifying fields are mandatory, preventing cross-purpose use.
   */
  async consume(input: {
    id: string;
    customerId: string | null;
    purpose: CustomerAuthChallengePurpose;
    subjectDigest: string;
    proofDigest: string;
    now: Date;
  }): Promise<boolean> {
    const owner = input.customerId === null
      ? isNull(customerAuthChallenges.customerId)
      : eq(customerAuthChallenges.customerId, input.customerId);
    const rows = await this.db.update(customerAuthChallenges)
      .set({ consumedAt: input.now })
      .where(and(
        eq(customerAuthChallenges.id, input.id),
        owner,
        eq(customerAuthChallenges.purpose, input.purpose),
        eq(customerAuthChallenges.subjectDigest, input.subjectDigest),
        eq(customerAuthChallenges.proofDigest, input.proofDigest),
        isNull(customerAuthChallenges.consumedAt),
        gt(customerAuthChallenges.expiresAt, input.now),
        lt(customerAuthChallenges.attempts, customerAuthChallenges.maxAttempts),
      ))
      .returning({ id: customerAuthChallenges.id });
    return rows.length === 1;
  }

  /** Count failed proof attempts without allowing attempts after expiry/consumption. */
  async recordFailedAttempt(input: {
    id: string;
    now: Date;
    scope?: { purpose: CustomerAuthChallengePurpose; subjectDigest: string; customerId?: string };
  }): Promise<boolean> {
    const scope = input.scope;
    const rows = await this.db.update(customerAuthChallenges)
      .set({ attempts: sql`${customerAuthChallenges.attempts} + 1` })
      .where(and(
        eq(customerAuthChallenges.id, input.id),
        scope ? and(
          eq(customerAuthChallenges.purpose, scope.purpose),
          eq(customerAuthChallenges.subjectDigest, scope.subjectDigest),
          scope.customerId ? eq(customerAuthChallenges.customerId, scope.customerId) : undefined,
        ) : undefined,
        isNull(customerAuthChallenges.consumedAt),
        gt(customerAuthChallenges.expiresAt, input.now),
        lt(customerAuthChallenges.attempts, customerAuthChallenges.maxAttempts),
      ))
      .returning({ id: customerAuthChallenges.id });
    return rows.length === 1;
  }
}
