import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerCredentialRepository } from '../../src/repositories/customer-credential.repository';

/**
 * CUSTOMER-PHONE-01 verified-only phone uniqueness (migration 0079): several customers may hold the same UNVERIFIED
 * number, at most one may hold it VERIFIED, and proving a number never hands you an account that merely typed it.
 */
describe.skipIf(!process.env.DATABASE_URL)('Verified-only phone uniqueness (real Postgres)', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let db: ReturnType<typeof buildDb>;
  const phone = () => `+1556${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`;
  const now = () => new Date();

  /** An email-registered customer: own credentials, typed a phone at registration, never verified it. */
  async function emailCustomerClaiming(number: string) {
    const customer = await repos.customers.create({ phone: number });
    await new CustomerCredentialRepository(db).create({
      customerId: customer.id,
      passwordHash: 'pbkdf2$1$c2FsdA$aGFzaA',
      now: now(),
      verifiedLoginEmail: { address: `u-${crypto.randomUUID()}@example.test`, verifiedAt: now() },
    });
    return customer;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    db = buildDb(client);
    repos = createRepositories(db);
  });
  afterAll(async () => {
    await client.end();
  });

  it('lets several customers hold the same UNVERIFIED number', async () => {
    const number = phone();
    const a = await repos.customers.create({ phone: number });
    const b = await repos.customers.create({ phone: number });
    expect(a.id).not.toBe(b.id);
    expect((await repos.customers.listByPhone(number)).map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('forbids a second VERIFIED holder at the database level', async () => {
    const number = phone();
    await repos.customers.create({ phone: number, phoneVerifiedAt: now() });
    await expect(repos.customers.create({ phone: number, phoneVerifiedAt: now() })).rejects.toThrow();
  });

  it('identifies by the verified owner only; listByPhone returns verified first', async () => {
    const number = phone();
    const claimant = await repos.customers.create({ phone: number });
    const owner = await repos.customers.create({ phone: number, phoneVerifiedAt: now() });
    expect((await repos.customers.findVerifiedByPhone(number))!.id).toBe(owner.id);
    const listed = await repos.customers.listByPhone(number);
    expect(listed[0]!.id).toBe(owner.id);
    expect(listed.map((c) => c.id)).toContain(claimant.id);
    expect(await repos.customers.findVerifiedByPhone(phone())).toBeUndefined();
  });

  it('proving a number NEVER logs you into an account that merely typed it: the prover gets their own verified account', async () => {
    const number = phone();
    const squatter = await emailCustomerClaiming(number);
    const { customer, created } = await repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() });
    expect(created).toBe(true);
    expect(customer!.id).not.toBe(squatter.id);
    expect(customer!.phoneVerifiedAt).not.toBeNull();
    const after = (await repos.customers.findById(squatter.id))!;
    expect(after.phone).toBeNull(); // the false claim is released ...
    expect(after.status).toBe('active'); // ... the squatter's account itself is untouched
    expect((await repos.customers.findVerifiedByPhone(number))!.id).toBe(customer!.id);
  });

  it('does not lock out a legacy phone-only account: the sole unverified holder without credentials is claimed', async () => {
    const number = phone();
    const legacy = await repos.customers.create({ phone: number }); // no credentials, never verified
    const { customer, created } = await repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() });
    expect(created).toBe(false);
    expect(customer!.id).toBe(legacy.id);
    expect(customer!.phoneVerifiedAt).not.toBeNull();
  });

  it('does not guess between several phone-only unverified holders: a new verified owner is created and claims released', async () => {
    const number = phone();
    const x = await repos.customers.create({ phone: number });
    const y = await repos.customers.create({ phone: number });
    const { customer, created } = await repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() });
    expect(created).toBe(true);
    expect([x.id, y.id]).not.toContain(customer!.id);
    expect((await repos.customers.findById(x.id))!.phone).toBeNull();
    expect((await repos.customers.findById(y.id))!.phone).toBeNull();
  });

  it('returns the existing verified owner on repeat proofs (idempotent)', async () => {
    const number = phone();
    const first = await repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() });
    const second = await repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() });
    expect(second.created).toBe(false);
    expect(second.customer!.id).toBe(first.customer!.id);
  });

  it('claimVerifiedPhone: first to verify owns the number, others are refused, claimants are released', async () => {
    const number = phone();
    const a = await emailCustomerClaiming(number);
    const b = await emailCustomerClaiming(number);
    const c = await emailCustomerClaiming(number);
    const won = await repos.customers.claimVerifiedPhone(a.id, number);
    expect(won.ok).toBe(true);
    expect(await repos.customers.claimVerifiedPhone(b.id, number)).toEqual({ ok: false, reason: 'taken' });
    expect((await repos.customers.findById(b.id))!.phone).toBeNull();
    expect((await repos.customers.findById(c.id))!.phone).toBeNull();
    expect((await repos.customers.findVerifiedByPhone(number))!.id).toBe(a.id);
    // The owner can repeat the claim without error.
    expect((await repos.customers.claimVerifiedPhone(a.id, number)).ok).toBe(true);
    expect(await repos.customers.claimVerifiedPhone(crypto.randomUUID(), phone())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('claimVerifiedPhone: two customers racing for one free number, exactly one wins', async () => {
    const number = phone();
    const a = await emailCustomerClaiming(number);
    const b = await emailCustomerClaiming(number);
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      const otherRepos = createRepositories(buildDb(other));
      const results = await Promise.all([
        repos.customers.claimVerifiedPhone(a.id, number),
        otherRepos.customers.claimVerifiedPhone(b.id, number),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'taken' }]);
    } finally {
      await other.end();
    }
    const owners = (await repos.customers.listByPhone(number)).filter((c) => c.phoneVerifiedAt);
    expect(owners).toHaveLength(1);
  });

  it('concurrent first proofs of one new number create one verified owner', async () => {
    const number = phone();
    const other = new Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      const otherRepos = createRepositories(buildDb(other));
      const [x, y] = await Promise.all([
        repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() }),
        otherRepos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() }),
      ]);
      expect(x.customer!.id).toBe(y.customer!.id);
      expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
    } finally {
      await other.end();
    }
  });

  it('a soft-deleted verified holder blocks the number cleanly instead of crashing', async () => {
    const number = phone();
    const gone = await repos.customers.create({ phone: number, phoneVerifiedAt: now() });
    await db.execute((await import('drizzle-orm')).sql`update customers set is_deleted = true where id = ${gone.id}`);
    const result = await repos.customers.createIfAbsent({ phone: number, phoneVerifiedAt: now() });
    expect(result.customer).toBeUndefined();
  });
});
