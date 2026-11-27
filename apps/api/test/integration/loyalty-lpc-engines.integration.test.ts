import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService } from '../../src/loyalty/programs/program.service';
import { recordProgrammeProgress } from '../../src/loyalty/programs/progress.service';
import { appDbOf } from '../helpers/runtime-db';
import { parseMoney } from '@echo-grid-feedback/shared-types';

/** LP-04 milestones, LP-05 streaks, LP-06 off-peak and LP-07 missions on a disposable PostgreSQL database. */
describe.skipIf(!process.env.DATABASE_URL)('LP-04 to LP-07 programmes (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;
  let ownerId: string;
  let businessId: string;
  let otherBusinessId: string;
  let branchId: string;
  let voucherId: string;
  let discountId: string;

  async function newBusiness(label: string, timezone = 'Asia/Kuwait') {
    const id = (await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `${label} ${run}` } as never, ownerId)).businessId;
    await admin.query(`update businesses set default_timezone=$2 where id=$1`, [id, timezone]);
    return id;
  }
  async function member(business = businessId) {
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId: business, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'lpc' });
    const account = await repos.loyaltyAccounts.create({ customerId: customer.id, businessId: business, membershipId: membership.id });
    return { accountId: account.id, customerId: customer.id };
  }
  const buy = (accountId: string, amount: number, key: string, business = businessId) =>
    loyalty.recordPurchase({ businessId: business, branchId, accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
  async function activate(type: string, config: Record<string, unknown>, business = businessId) {
    const draft = await programmes.createDraft(business, ownerId, { type, config });
    await programmes.validate(business, ownerId, draft.id);
    await programmes.activate(business, ownerId, draft.id);
    return draft.id;
  }
  const entitlementKeys = async (accountId: string) => (await admin.query(`select source_key from loyalty_program_entitlements where loyalty_account_id=$1 order by source_key`, [accountId])).rows.map((r) => r.source_key as string);
  const counters = async (programId: string, accountId: string) => (await admin.query(`select counters from loyalty_program_progress where program_id=$1 and loyalty_account_id=$2`, [programId, accountId])).rows[0]?.counters;
  async function race<T>(count: number, fn: (service: LoyaltyAccountService, index: number) => Promise<T>): Promise<T[]> {
    const clients = await Promise.all(Array.from({ length: count }, async () => { const c = new Client({ connectionString: process.env.DATABASE_URL }); await c.connect(); return c; }));
    try { return await Promise.all(clients.map((c, i) => fn(new LoyaltyAccountService(buildDb(c)), i))); } finally { await Promise.all(clients.map((c) => c.end())); }
  }
  /** Drives the progress service with an explicit historical event (the services record real events at "now"). */
  async function feed(programId: string, version: number, type: 'LP-04' | 'LP-05' | 'LP-07', config: Record<string, unknown>, m: { accountId: string; customerId: string }, key: string, event: Parameters<typeof recordProgrammeProgress>[1]['event'], business = businessId, timeZone = 'Asia/Kuwait') {
    const db = buildDb(admin);
    return db.transaction((tx) => recordProgrammeProgress(tx, { businessId: business, programId, programVersion: version, type, config, loyaltyAccountId: m.accountId, customerId: m.customerId, eventKey: key, event, timeZone }));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = (await repos.users.create({ email: `lpc-eng-${run}@example.test`, fullName: 'owner', passwordHash: 'x', status: 'active' })).id;
    businessId = await newBusiness('LPC engines');
    otherBusinessId = await newBusiness('LPC engines other');
    branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `lpc-eng-${run}` })).id;
    voucherId = (await repos.loyaltyRewards.create({ businessId, name: 'Voucher', type: 'voucher', status: 'active', createdBy: ownerId } as never)).id;
    discountId = (await repos.loyaltyRewards.create({ businessId, name: 'Discount', type: 'discount', rewardValue: '5.00', status: 'active', createdBy: ownerId } as never)).id;
  });

  afterAll(async () => { await admin.end(); });

  it('only accepts active earned-prize rewards of this business for the progress programmes', async () => {
    const pointsReward = (await repos.loyaltyRewards.create({ businessId, name: 'Points', type: 'points', pointsCost: 10, status: 'active', createdBy: ownerId } as never)).id;
    const foreign = (await repos.loyaltyRewards.create({ businessId: otherBusinessId, name: 'Foreign', type: 'voucher', status: 'active', createdBy: ownerId } as never)).id;
    for (const bad of [pointsReward, foreign, crypto.randomUUID()]) {
      await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-04', config: { metric: 'purchases', milestones: [{ threshold: '2', rewardId: bad }] } })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID' });
    }
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-04', config: { metric: 'purchases', milestones: [{ threshold: '2', rewardId: voucherId }, { threshold: '4', rewardId: discountId }] } })).resolves.toMatchObject({ status: 'draft' });
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-08', config: {} })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID' });
  });

  it('LP-04: real purchases unlock each milestone once, race-safely, and never change the membership tier', async () => {
    await repos.loyaltyTiers.create({ businessId, name: 'Silver', minPoints: 1, sortOrder: 1 });
    const programId = await activate('LP-04', { metric: 'purchases', milestones: [{ threshold: '2', rewardId: voucherId }, { threshold: '4', rewardId: discountId }] });
    const m = await member();
    const first = await buy(m.accountId, 10, `m-${run}-1`);
    expect(first.account.points).toBe(0);
    expect(first.account.tierId).toBeNull(); // a milestone programme earns no points, so no tier moves
    await buy(m.accountId, 10, `m-${run}-1`); // replay
    expect(await entitlementKeys(m.accountId)).toEqual([]);
    await buy(m.accountId, 10, `m-${run}-2`);
    expect(await entitlementKeys(m.accountId)).toEqual(['milestone:2']);
    await race(6, (service, i) => service.recordPurchase({ businessId, branchId, accountId: m.accountId, purchaseAmount: 10, idempotencyKey: `m-${run}-r${i}`, channel: 'branch', staffUserId: ownerId }));
    expect(await entitlementKeys(m.accountId)).toEqual(['milestone:2', 'milestone:4']); // 8 receipts total: each milestone exactly once
    expect(await counters(programId, m.accountId)).toMatchObject({ count: 8 });
    const ledger = (await admin.query(`select count(*)::int n, sum(points)::int p, count(distinct program_id)::int progs from loyalty_transactions where loyalty_account_id=$1`, [m.accountId])).rows[0];
    expect(ledger).toEqual({ n: 8, p: 0, progs: 1 });
  });

  it('LP-04: check-ins count as visits and a visits ladder unlocks its milestone', async () => {
    const business = await newBusiness('LPC visits');
    const branch = (await repos.branches.create({ businessId: business, name: 'Main', slug: `lpc-v-${run}` })).id;
    const qr = (await repos.qrCodes.create({ businessId: business, branchId: branch })).id;
    const reward = (await repos.loyaltyRewards.create({ businessId: business, name: 'Visit prize', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const programId = await activate('LP-04', { metric: 'visits', milestones: [{ threshold: '3', rewardId: reward }] }, business);
    const m = await member(business);
    for (let i = 0; i < 2; i += 1) await loyalty.recordCheckin(m.customerId, business, qr);
    expect(await entitlementKeys(m.accountId)).toEqual([]);
    await loyalty.recordCheckin(m.customerId, business, qr);
    expect(await entitlementKeys(m.accountId)).toEqual(['milestone:3']);
    expect(await counters(programId, m.accountId)).toMatchObject({ count: 3 });
  });

  it('LP-05: a business-local streak completes across days, counts a day once and breaks on a gap', async () => {
    const business = await newBusiness('LPC streak', 'Asia/Kuwait');
    const reward = (await repos.loyaltyRewards.create({ businessId: business, name: 'Streak prize', type: 'voucher', status: 'active', createdBy: ownerId } as never)).id;
    const config = { period: 'day', requiredPeriods: 3, gracePeriods: 0, evidence: 'visit', rewardId: reward };
    const programId = await activate('LP-05', config, business);
    const m = await member(business);
    const stored = (await programmes.list(business)).find((p) => p.id === programId)!;
    const go = (key: string, iso: string) => feed(programId, stored.currentVersion, 'LP-05', stored.config, m, key, { kind: 'visit', occurredAt: new Date(iso) }, business);
    expect((await go('v1', '2026-05-01T21:30:00Z')).applied).toBe(true); // 00:30 on 2 May in Kuwait
    expect((await go('v2', '2026-05-02T08:00:00Z')).reason).toBe('SAME_PERIOD'); // same Kuwait day although the UTC day differs
    await go('v3', '2026-05-03T08:00:00Z');
    expect(await entitlementKeys(m.accountId)).toEqual([]);
    const done = await go('v4', '2026-05-04T08:00:00Z');
    expect(done.grantedEntitlements).toBe(1);
    expect(await entitlementKeys(m.accountId)).toEqual(['streak:1']);
    expect((await go('v4', '2026-05-04T08:00:00Z')).reason).toBe('DUPLICATE_EVENT'); // a replayed event is a no-op
    await go('v5', '2026-05-05T08:00:00Z');
    await go('v6', '2026-05-08T08:00:00Z'); // days 6 and 7 missed
    expect(await counters(programId, m.accountId)).toMatchObject({ streak: 1, cycle: 1 });
    const history = (await admin.query(`select kind from loyalty_program_progress_events where loyalty_account_id=$1 and kind in ('streak_broken','streak_completed')`, [m.accountId])).rows.map((r) => r.kind);
    expect(history.sort()).toEqual(['streak_broken', 'streak_completed']);
  });

  it('LP-06: the off-peak effect is computed from the SERVER time in the business timezone', async () => {
    const business = await newBusiness('LPC offpeak', 'Asia/Kuwait');
    // Every day, all day (except the last minute): the multiplier must apply to a purchase made now.
    const all = await activate('LP-06', { pointsPerCurrencyUnit: '1', windows: [{ days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59', multiplier: '3' }] }, business);
    const m = await member(business);
    const nowKuwait = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuwait', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const inLastMinute = nowKuwait === '23:59';
    const first = await buy(m.accountId, 10, `op-${run}-1`, business);
    expect(first.account.points).toBe(inLastMinute ? 10 : 30);
    expect((await admin.query(`select program_id, points from loyalty_transactions where loyalty_account_id=$1 and type='purchase'`, [m.accountId])).rows[0]).toMatchObject({ program_id: all, points: first.account.points });
    // A window on a day that is NOT today in Kuwait never applies.
    const weekdayToday = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuwait', weekday: 'short' }).formatToParts(new Date()).find((p) => p.type === 'weekday') && ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kuwait', weekday: 'short' }).format(new Date())]);
    const otherDay = (weekdayToday % 7) + 1;
    const other = await programmes.createDraft(business, ownerId, { type: 'LP-06', config: { pointsPerCurrencyUnit: '1', windows: [{ days: [otherDay], start: '00:00', end: '23:59', multiplier: '3' }] } });
    await programmes.validate(business, ownerId, other.id);
    await programmes.activate(business, ownerId, other.id);
    const second = await buy(m.accountId, 10, `op-${run}-2`, business);
    expect(second.account.points).toBe(first.account.points + 10);
    // A cashier cannot influence eligibility: the purchase API has no time input, and the stored instant is the database clock.
    const stored = (await admin.query(`select abs(extract(epoch from (now() - occurred_at)))::int s from loyalty_purchase_events where loyalty_account_id=$1 order by occurred_at desc limit 1`, [m.accountId])).rows[0];
    expect(stored.s).toBeLessThan(60);
  });

  it('LP-07: a mission pays once inside its window; expiry restarts it; two missions advance independently', async () => {
    const business = await newBusiness('LPC missions', 'Asia/Kuwait');
    const reward = (await repos.loyaltyRewards.create({ businessId: business, name: 'Mission prize', type: 'free_item', status: 'active', createdBy: ownerId } as never)).id;
    const config = { missions: [{ key: 'three-in-seven', objective: 'purchases', target: '3', windowDays: 7, rewardId: reward }, { key: 'spend-50', objective: 'spend', target: '50', windowDays: 30, rewardId: reward }] };
    const programId = await activate('LP-07', config, business);
    const m = await member(business);
    const stored = (await programmes.list(business)).find((p) => p.id === programId)!;
    const go = (key: string, iso: string, amount = '5.00') => feed(programId, stored.currentVersion, 'LP-07', stored.config, m, key, { kind: 'purchase', amountMinor: parseMoney(amount, 'USD'), currency: 'USD', occurredAt: new Date(iso) }, business);
    await go('a1', '2026-06-01T10:00:00Z');
    await go('a2', '2026-06-02T10:00:00Z');
    await go('a3', '2026-06-09T10:00:00Z'); // outside the 7-day window: the mission restarted
    expect(await entitlementKeys(m.accountId)).toEqual([]);
    await go('a4', '2026-06-10T10:00:00Z');
    const done = await go('a5', '2026-06-11T10:00:00Z');
    expect(done.grantedEntitlements).toBe(1);
    await go('a6', '2026-06-12T10:00:00Z'); // already completed: never pays again
    expect(await entitlementKeys(m.accountId)).toEqual(['mission:three-in-seven']);
    await go('a7', '2026-06-13T10:00:00Z', '30.00'); // spend so far 5x6 + 30 = 60
    expect(await entitlementKeys(m.accountId)).toEqual(['mission:spend-50', 'mission:three-in-seven']);
  });

  it('progress is tenant-bound: a foreign account is refused by the database and an event on a frozen programme does nothing', async () => {
    const business = await newBusiness('LPC frozen', 'Asia/Kuwait');
    const reward = (await repos.loyaltyRewards.create({ businessId: business, name: 'Prize', type: 'voucher', status: 'active', createdBy: ownerId } as never)).id;
    const programId = await activate('LP-04', { metric: 'purchases', milestones: [{ threshold: '1', rewardId: reward }] }, business);
    const stored = (await programmes.list(business)).find((p) => p.id === programId)!;
    const foreign = await member(otherBusinessId);
    await expect(feed(programId, stored.currentVersion, 'LP-04', stored.config, foreign, 'x1', { kind: 'visit', occurredAt: new Date() }, business)).rejects.toThrow();
    const m = await member(business);
    await buy(m.accountId, 5, `fz-${run}-1`, business);
    expect(await entitlementKeys(m.accountId)).toEqual(['milestone:1']);
    const next = await programmes.createDraft(business, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 } });
    await programmes.validate(business, ownerId, next.id);
    await programmes.activate(business, ownerId, next.id);
    expect((await feed(programId, stored.currentVersion, 'LP-04', stored.config, m, 'late', { kind: 'visit', occurredAt: new Date() }, business)).reason).toBe('FROZEN');
  });
});
