import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { buildDb } from '../../src/db/client';
import { customers } from '../../src/db/schema';
import { CustomerAuthChallengeRepository } from '../../src/repositories/customer-auth-challenge.repository';

describe.skipIf(!process.env.DATABASE_URL)('CUSTOMER-AUTH-01D-4b-S1 disposable PostgreSQL', () => {
  let client: Client;
  let db: ReturnType<typeof buildDb>;
  let repo: CustomerAuthChallengeRepository;
  const ids: string[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repo = new CustomerAuthChallengeRepository(db);
  });

  afterAll(async () => {
    for (const id of ids) await db.delete(customers).where(eq(customers.id, id));
    await client.end();
  });

  it('permits multiple phone-free customers without changing customer IDs', async () => {
    const [a] = await db.insert(customers).values({ phone: null }).returning();
    const [b] = await db.insert(customers).values({ phone: null }).returning();
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBeTruthy();
    expect(a?.id).not.toBe(b?.id);
    ids.push(a!.id, b!.id);
  });

  it('keeps populated phone numbers globally unique', async () => {
    const phone = '+1555' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    const [a] = await db.insert(customers).values({ phone }).returning();
    ids.push(a!.id);
    await expect(db.insert(customers).values({ phone })).rejects.toThrow();
  });

  it('consumes a proof once under concurrent requests and rejects replay and wrong purpose', async () => {
    const now = new Date();
    const subjectDigest = 'a'.repeat(64);
    const proofDigest = 'b'.repeat(64);
    const id = await repo.create({ purpose: 'email_registration', subjectDigest, proofDigest, now, expiresAt: new Date(now.getTime() + 15 * 60_000) });
    const input = { id, customerId: null, purpose: 'email_registration' as const, subjectDigest, proofDigest, now };
    expect(await repo.consume({ ...input, purpose: 'email_recovery' })).toBe(false);
    const secondClient = new Client({ connectionString: process.env.DATABASE_URL });
    await secondClient.connect();
    let results: boolean[];
    try {
      const secondRepo = new CustomerAuthChallengeRepository(buildDb(secondClient));
      results = await Promise.all([repo.consume(input), secondRepo.consume(input)]);
    } finally {
      await secondClient.end();
    }
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await repo.consume(input)).toBe(false);
  });

  it('rejects expired and wrong-proof challenges and enforces five attempts', async () => {
    const now = new Date();
    const subjectDigest = 'c'.repeat(64);
    const proofDigest = 'd'.repeat(64);
    const id = await repo.create({ purpose: 'email_link', subjectDigest, proofDigest, now: new Date(now.getTime() - 120000), expiresAt: new Date(now.getTime() - 60000) });
    expect(await repo.consume({ id, customerId: null, purpose: 'email_link', subjectDigest, proofDigest, now })).toBe(false);
    const live = await repo.create({ purpose: 'email_link', subjectDigest, proofDigest, now, expiresAt: new Date(now.getTime() + 60000) });
    expect(await repo.consume({ id: live, customerId: null, purpose: 'email_link', subjectDigest, proofDigest: 'e'.repeat(64), now })).toBe(false);
    for (let i = 0; i < 5; i++) expect(await repo.recordFailedAttempt({ id: live, now })).toBe(true);
    expect(await repo.recordFailedAttempt({ id: live, now })).toBe(false);
    expect(await repo.consume({ id: live, customerId: null, purpose: 'email_link', subjectDigest, proofDigest, now })).toBe(false);
  });
});
