import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';

/**
 * Gate 2 R6: actual repository queries against a disposable PostgreSQL
 * database, with two isolated businesses and ONE intentionally global
 * customer. No production or staging target and no financial operations.
 */
const url = process.env.DATABASE_URL;
const targetIsDisposable = (() => {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) &&
      /^echogrid_(?:test|ci_[a-z0-9_]+)$/.test(decodeURIComponent(parsed.pathname.slice(1))) &&
      !parsed.search && !parsed.hash;
  } catch { return false; }
})();

describe.skipIf(!targetIsDisposable)('Gate 2 R6 nonfinancial tenant-isolation integration', () => {
  let client: Client;
  let repos: ReturnType<typeof createRepositories>;
  let a: string;
  let b: string;
  let branchA: string;
  let branchB: string;
  let qrAId: string;
  let qrBId: string;
  let feedbackA: string;
  let feedbackB: string;
  let accountA: string;
  let accountB: string;
  let surveyA: string;
  let surveyB: string;
  const actor = crypto.randomUUID();

  beforeAll(async () => {
    if (!targetIsDisposable || !url) throw new Error('GATE2_R6_NON_DISPOSABLE_TARGET_DENIED');
    client = new Client({ connectionString: url });
    await client.connect();
    const db = buildDb(client);
    repos = createRepositories(db);
    const suffix = crypto.randomUUID();
    const [bizA, bizB] = await Promise.all([
      repos.businesses.create({ name: 'R6 synthetic business A', slug: `gate2-r6-a-${suffix}` }),
      repos.businesses.create({ name: 'R6 synthetic business B', slug: `gate2-r6-b-${suffix}` }),
    ]);
    a = bizA.id; b = bizB.id;
    const [first, second] = await Promise.all([
      repos.branches.create({ businessId: a, name: 'A only', slug: `r6-a-${suffix}` }),
      repos.branches.create({ businessId: b, name: 'B only', slug: `r6-b-${suffix}` }),
    ]);
    branchA = first.id; branchB = second.id;
    const [qrA, qrB] = await Promise.all([
      repos.qrCodes.create({ businessId: a, branchId: branchA }),
      repos.qrCodes.create({ businessId: b, branchId: branchB }),
    ]);
    qrAId = qrA.id; qrBId = qrB.id;
    const [fA, fB] = await Promise.all([
      repos.feedback.create({ businessId: a, branchId: branchA, qrCodeId: qrA.id, rating: 5, comment: 'private A' }),
      repos.feedback.create({ businessId: b, branchId: branchB, qrCodeId: qrB.id, rating: 2, comment: 'private B' }),
    ]);
    feedbackA = fA.id; feedbackB = fB.id;
    // Customers have global identity by design; tenant separation applies
    // to their per-business loyalty memberships, not customer identity.
    const customer = await repos.customers.create({
      phone: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
    });
    const [la, lb] = await Promise.all([
      repos.loyaltyAccounts.create({ customerId: customer.id, businessId: a }),
      repos.loyaltyAccounts.create({ customerId: customer.id, businessId: b }),
    ]);
    accountA = la.id; accountB = lb.id;
    const [sa, sb] = await Promise.all([
      repos.surveys.createSurvey({ ownerType: 'business', businessId: a, name: 'R6 private survey A' }),
      repos.surveys.createSurvey({ ownerType: 'business', businessId: b, name: 'R6 private survey B' }),
    ]);
    surveyA = sa.id; surveyB = sb.id;
  });

  afterAll(async () => { if (client) await client.end(); });

  it('R6-01 refuses foreign branch and QR records even when UUID is known', async () => {
    expect((await repos.branches.findById(branchA, a))?.id).toBe(branchA);
    expect((await repos.branches.findById(branchB, b))?.id).toBe(branchB);
    expect(await repos.branches.findById(branchA, b)).toBeUndefined();
    expect(await repos.branches.findById(branchB, a)).toBeUndefined();
    expect((await repos.qrCodes.findById(qrAId, a))?.id).toBe(qrAId);
    expect((await repos.qrCodes.findById(qrBId, b))?.id).toBe(qrBId);
    expect(await repos.qrCodes.findById(qrAId, b)).toBeUndefined();
    expect(await repos.qrCodes.findById(qrBId, a)).toBeUndefined();
    expect((await repos.branches.listByBusiness(a)).map(x => x.id)).toContain(branchA);
    expect((await repos.branches.listByBusiness(a)).map(x => x.id)).not.toContain(branchB);
  });

  it('R6-02 isolates feedback reads and rejects cross-tenant status edits', async () => {
    expect((await repos.feedback.findById(feedbackA, a))?.comment).toBe('private A');
    expect((await repos.feedback.findById(feedbackB, b))?.comment).toBe('private B');
    expect(await repos.feedback.findById(feedbackA, b)).toBeUndefined();
    expect(await repos.feedback.findById(feedbackB, a)).toBeUndefined();
    expect(await repos.feedback.markReviewed(feedbackA, b, actor)).toBeUndefined();
    expect((await repos.feedback.findById(feedbackA, a))?.status).toBe('new');
  });

  it('R6-03 maintains per-business loyalty isolation for a shared global customer', async () => {
    const ownA = await repos.loyaltyAccounts.findById(accountA, a);
    const ownB = await repos.loyaltyAccounts.findById(accountB, b);
    expect(ownA?.points).toBe(0);
    expect(ownB?.points).toBe(0);
    expect(await repos.loyaltyAccounts.findById(accountA, b)).toBeUndefined();
    expect(await repos.loyaltyAccounts.findById(accountB, a)).toBeUndefined();
    const listedA = await repos.loyaltyAccounts.listForBusiness(a);
    const listedB = await repos.loyaltyAccounts.listForBusiness(b);
    expect(listedA.map(x => x.id)).toContain(accountA);
    expect(listedA.map(x => x.id)).not.toContain(accountB);
    expect(listedB.map(x => x.id)).toContain(accountB);
    expect(listedB.map(x => x.id)).not.toContain(accountA);
  });

  it('R6-04 isolates survey lookup, listing and status transitions', async () => {
    expect((await repos.surveys.findBusinessOwnedById(surveyA, a))?.id).toBe(surveyA);
    expect((await repos.surveys.findBusinessOwnedById(surveyB, b))?.id).toBe(surveyB);
    expect(await repos.surveys.findBusinessOwnedById(surveyA, b)).toBeUndefined();
    expect(await repos.surveys.findBusinessOwnedById(surveyB, a)).toBeUndefined();
    expect((await repos.surveys.listForBusiness(a)).map(s => s.id)).not.toContain(surveyB);
    expect((await repos.surveys.listForBusiness(b)).map(s => s.id)).not.toContain(surveyA);
    expect(await repos.surveys.updateSurveyStatus(surveyA, b, 'paused', actor)).toBeUndefined();
    expect((await repos.surveys.findBusinessOwnedById(surveyA, a))?.status).toBe('draft');
  });
});
