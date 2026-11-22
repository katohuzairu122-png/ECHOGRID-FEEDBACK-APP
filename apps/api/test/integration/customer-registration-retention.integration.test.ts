import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { customerAuthChallenges } from '../../src/db/schema';
import { CustomerAuthChallengeRepository } from '../../src/repositories/customer-auth-challenge.repository';
import { purgeExpiredRegistrationCiphertext } from '../../src/customer-auth/customer-registration-retention';

const url = process.env.DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(target.hostname) ||
      !['/echogrid_test', '/echogrid_ci_pg18'].includes(target.pathname)) {
    throw new Error('Retention integration test requires a disposable loopback PostgreSQL database.');
  }
}

describe.skipIf(!url)('pending-registration ciphertext cleanup (disposable PostgreSQL)', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  const created: string[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: url });
    await client.connect();
    db = buildDb(client);
  });

  afterAll(async () => {
    if (!client) return;
    for (const id of created) {
      await db.delete(customerAuthChallenges).where(eq(customerAuthChallenges.id, id));
    }
    await client.end();
  });

  async function challenge(expiresAt: Date, createdAt: Date) {
    const repository = new CustomerAuthChallengeRepository(db);
    const unique = crypto.randomUUID().replace(/-/g, '');
    const id = await repository.create({
      purpose: 'email_registration',
      subjectDigest: unique.padEnd(64, 'a'),
      proofDigest: unique.padEnd(64, 'b'),
      expiresAt, now: createdAt,
      registrationSealedData: 'v1.synthetic-ciphertext-not-a-real-secret',
    });
    created.push(id);
    return id;
  }

  async function sealed(id: string) {
    const [row] = await db.select({
      value: customerAuthChallenges.registrationSealedData,
    }).from(customerAuthChallenges).where(eq(customerAuthChallenges.id, id));
    return row?.value;
  }

  it('clears only expired sealed content, in bounded batches; leaves live challenges and rows untouched', async () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000);
    const oldCreated = new Date(now.getTime() - 30 * 60_000);
    const liveAt = new Date(now.getTime() + 10 * 60_000);
    const first = await challenge(expiredAt, oldCreated);
    const second = await challenge(expiredAt, oldCreated);
    const live = await challenge(liveAt, now);

    await purgeExpiredRegistrationCiphertext(db, now, 1);
    const afterFirst = [await sealed(first), await sealed(second)];
    expect(afterFirst.filter((value) => value === null)).toHaveLength(1);
    expect(await sealed(live)).not.toBeNull();

    await purgeExpiredRegistrationCiphertext(db, now, 1);
    expect(await sealed(first)).toBeNull();
    expect(await sealed(second)).toBeNull();
    expect(await sealed(live)).not.toBeNull();
    const [historical] = await db.select({ id: customerAuthChallenges.id })
      .from(customerAuthChallenges).where(eq(customerAuthChallenges.id, first));
    expect(historical?.id).toBe(first);
  });

  it('refuses invalid caller-controlled bounds before accessing the database', async () => {
    const now = new Date();
    for (const limit of [0, -1, 501, 1.5, Number.NaN]) {
      await expect(purgeExpiredRegistrationCiphertext(db, now, limit)).rejects.toThrow();
    }
    await expect(purgeExpiredRegistrationCiphertext(db, new Date(Number.NaN), 1)).rejects.toThrow();
  });
});
