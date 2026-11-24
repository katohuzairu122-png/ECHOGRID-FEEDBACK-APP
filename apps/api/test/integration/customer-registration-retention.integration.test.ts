import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { CustomerAuthChallengeRepository } from '../../src/repositories/customer-auth-challenge.repository';
import { purgeExpiredRegistrationCiphertext } from '../../src/customer-auth/customer-registration-retention';

/** D03 cleanup acceptance against disposable PostgreSQL only. */
describe.skipIf(!process.env.DATABASE_URL)('pending registration ciphertext retention (Postgres)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let challenges: CustomerAuthChallengeRepository;
  const ids: string[] = [];
  const digest = (n: number) => `${n.toString(16).padStart(2, '0')}${'a'.repeat(62)}`;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    challenges = new CustomerAuthChallengeRepository(db);
  });

  afterAll(async () => {
    if (ids.length) await client.query('DELETE FROM customer_auth_challenges WHERE id = ANY($1::uuid[])', [ids]);
    await client.end();
  });

  it('clears expired sealed payloads in bounded, idempotent batches and preserves live challenge evidence', async () => {
    const now = new Date();
    const expiredCreatedAt = new Date(now.getTime() - 3 * 86_400_000);
    const expiredAt = new Date(now.getTime() - 86_400_000);
    const expiredA = await challenges.create({
      purpose: 'email_registration', subjectDigest: digest(1), proofDigest: digest(2),
      expiresAt: expiredAt, now: expiredCreatedAt,
      registrationSealedData: 'v1.synthetic-ciphertext-a',
    });
    const expiredB = await challenges.create({
      purpose: 'email_registration', subjectDigest: digest(3), proofDigest: digest(4),
      expiresAt: expiredAt, now: expiredCreatedAt,
      registrationSealedData: 'v1.synthetic-ciphertext-b',
    });
    const live = await challenges.create({
      purpose: 'email_registration', subjectDigest: digest(5), proofDigest: digest(6),
      expiresAt: new Date(now.getTime() + 900_000), now,
      registrationSealedData: 'v1.synthetic-live-ciphertext',
    });
    ids.push(expiredA, expiredB, live);

    const eligibleCount = async () => Number((await client.query(
      `SELECT count(*)::int AS n FROM customer_auth_challenges
       WHERE purpose='email_registration' AND registration_sealed_data IS NOT NULL AND expires_at <= now()`,
    )).rows[0].n);
    const before = await eligibleCount();
    await purgeExpiredRegistrationCiphertext(db, new Date(), 1);
    const afterOneBatch = await eligibleCount();
    expect(afterOneBatch).toBe(before - 1);

    await purgeExpiredRegistrationCiphertext(db, new Date(), 500);
    const expired = await client.query(
      `SELECT id, registration_sealed_data, attempts, subject_digest, proof_digest
       FROM customer_auth_challenges WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[expiredA, expiredB]],
    );
    expect(expired.rows).toHaveLength(2);
    expect(expired.rows.every((row) => row.registration_sealed_data === null)).toBe(true);
    expect(expired.rows.every((row) => row.subject_digest && row.proof_digest && row.attempts === 0)).toBe(true);

    const liveRow = (await client.query(
      'SELECT registration_sealed_data FROM customer_auth_challenges WHERE id=$1', [live],
    )).rows[0];
    expect(liveRow.registration_sealed_data).toBe('v1.synthetic-live-ciphertext');

    await purgeExpiredRegistrationCiphertext(db, new Date(), 500);
    const countAfterRepeat = await eligibleCount();
    expect(countAfterRepeat).toBe(0);
    expect((await client.query('SELECT id FROM customer_auth_challenges WHERE id=ANY($1::uuid[])', [[expiredA, expiredB, live]])).rowCount).toBe(3);
  });

  it('rejects untrusted timestamps and unbounded batch sizes', async () => {
    await expect(purgeExpiredRegistrationCiphertext(db, new Date(Number.NaN), 1)).rejects.toThrow();
    await expect(purgeExpiredRegistrationCiphertext(db, new Date(), 0)).rejects.toThrow();
    await expect(purgeExpiredRegistrationCiphertext(db, new Date(), 501)).rejects.toThrow();
  });
});
