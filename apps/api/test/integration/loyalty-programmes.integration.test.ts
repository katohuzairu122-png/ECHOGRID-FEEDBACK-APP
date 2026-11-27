import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { BusinessService } from '../../src/businesses/business.service';
import { LoyaltyAccountService } from '../../src/loyalty/loyalty-account.service';
import { LoyaltyProgramService, resolveActiveProgramme } from '../../src/loyalty/programs/program.service';
import { appDbOf } from '../helpers/runtime-db';

/**
 * LOYALTY-PROGRAMME-COMPLETION, Group 01 acceptance on a disposable PostgreSQL database: lifecycle, the one-active invariant (application AND
 * database), Owner-only activation, transactional switching, provenance, exact earning, Configure Later, legacy compatibility, tenant isolation.
 */
describe.skipIf(!process.env.DATABASE_URL)('loyalty programmes (integration)', () => {
  const run = crypto.randomUUID().slice(0, 8);
  let admin: Client;
  let raceA: Client;
  let raceB: Client;
  let repos: ReturnType<typeof createRepositories>;
  let programmes: LoyaltyProgramService;
  let loyalty: LoyaltyAccountService;
  let ownerId: string;
  let managerId: string;
  let businessId: string;
  let otherBusinessId: string;
  let branchId: string;

  async function makeUser(label: string) {
    return (await repos.users.create({ email: `${label}-${run}@example.test`, fullName: label, passwordHash: 'x', status: 'active' })).id;
  }
  async function makeMember(business: string) {
    const customer = await repos.customers.create({ phone: `+1555${Math.floor(Math.random() * 1e9)}${Date.now() % 1000}` });
    const membership = await repos.customerMemberships.create({ customerId: customer.id, businessId: business, status: 'active', onboardingSource: 'integration_test', onboardingReference: 'lpc' });
    const account = await repos.loyaltyAccounts.create({ customerId: customer.id, businessId: business, membershipId: membership.id });
    return { customerId: customer.id, accountId: account.id };
  }
  const buy = (accountId: string, amount: number, key: string, business = businessId) =>
    loyalty.recordPurchase({ businessId: business, branchId, accountId, purchaseAmount: amount, idempotencyKey: key, channel: 'branch', staffUserId: ownerId });
  async function activeCount(business = businessId) {
    return Number((await admin.query(`select count(*)::int n from loyalty_programs where business_id=$1 and status='active'`, [business])).rows[0].n);
  }
  async function draftAndValidate(type: string, config: Record<string, unknown>, business = businessId) {
    const draft = await programmes.createDraft(business, ownerId, { type, config });
    return programmes.validate(business, ownerId, draft.id);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: process.env.DATABASE_URL });
    raceA = new Client({ connectionString: process.env.DATABASE_URL });
    raceB = new Client({ connectionString: process.env.DATABASE_URL });
    await Promise.all([admin.connect(), raceA.connect(), raceB.connect()]);
    const db = buildDb(admin);
    repos = createRepositories(db);
    programmes = new LoyaltyProgramService(appDbOf(db));
    loyalty = new LoyaltyAccountService(appDbOf(db));
    ownerId = await makeUser('owner');
    managerId = await makeUser('manager');
    const business = await new BusinessService(appDbOf(db)).createBusiness({ name: `LPC ${run}` } as never, ownerId);
    businessId = business.businessId;
    const other = await new BusinessService(appDbOf(db)).createBusiness({ name: `LPC other ${run}` } as never, ownerId);
    otherBusinessId = other.businessId;
    const managerRole = await repos.roles.findByName(businessId, 'Manager');
    await repos.userBusinessRoles.grant({ userId: managerId, businessId, roleId: managerRole!.id } as never);
    branchId = (await repos.branches.create({ businessId, name: 'Main', slug: `lpc-${run}` })).id;
  });

  afterAll(async () => {
    await Promise.all([admin.end(), raceA.end(), raceB.end()]);
  });

  it('offers eight programme cards and only the completed ones are available; LP-08 is never activatable', async () => {
    const registry = programmes.registry();
    expect(registry.map((r) => r.type)).toEqual(['LP-01', 'LP-02', 'LP-03', 'LP-04', 'LP-05', 'LP-06', 'LP-07', 'LP-08']);
    expect(registry.find((r) => r.type === 'LP-03')?.available).toBe(true);
    expect(registry.find((r) => r.type === 'LP-08')).toMatchObject({ available: false, unavailableReason: 'NEEDS_ITEM_LEVEL_EVIDENCE' });
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-08', config: {} })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID', status: 422 });
    // Even a direct database write cannot activate LP-08: the check constraint is the last line of defence.
    const lp08 = (await admin.query(`insert into loyalty_programs (business_id, type, status) values ($1,'LP-08','draft') returning id`, [businessId])).rows[0].id;
    await admin.query(`insert into loyalty_program_versions (program_id, business_id, version, config, config_hash) values ($1,$2,1,'{}'::jsonb,'x')`, [lp08, businessId]);
    await admin.query(`update loyalty_programs set status='validated' where id=$1`, [lp08]);
    await expect(admin.query(`update loyalty_programs set status='active' where id=$1`, [lp08])).rejects.toThrow(/loyalty_programs_lp08_not_activatable/);
  });

  it('rejects an invalid configuration with field-level errors and stores nothing', async () => {
    const before = (await programmes.list(businessId)).length;
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '1.23456', pointsPerCheckin: 5 } })).rejects.toMatchObject({
      code: 'PROGRAM_CONFIG_INVALID',
      details: [expect.objectContaining({ path: 'pointsPerCurrencyUnit' })],
    });
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-02', config: { pointsPerPurchase: 0 } })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID' });
    await expect(programmes.createDraft(businessId, ownerId, { type: 'LP-02', config: { pointsPerPurchase: 5, minimumPurchaseAmount: '1.005' } })).rejects.toMatchObject({ code: 'PROGRAM_CONFIG_INVALID' });
    expect((await programmes.list(businessId)).length).toBe(before);
  });

  it('runs the lifecycle draft -> validated -> active with versions, events and an Owner-only activation', async () => {
    const draft = await programmes.createDraft(businessId, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '2', pointsPerCheckin: 5 } });
    expect(draft).toMatchObject({ status: 'draft', currentVersion: 1, legacy: false });
    await expect(programmes.activate(businessId, ownerId, draft.id)).rejects.toMatchObject({ code: 'PROGRAM_NOT_ACTIVATABLE', status: 409 });
    const validated = await programmes.validate(businessId, ownerId, draft.id);
    expect(validated.status).toBe('validated');
    await expect(programmes.activate(businessId, managerId, draft.id)).rejects.toMatchObject({ code: 'PROGRAM_OWNER_REQUIRED', status: 403 });
    expect(await activeCount()).toBe(0);
    const { activated, previous } = await programmes.activate(businessId, ownerId, draft.id);
    expect(activated.status).toBe('active');
    expect(previous).toBeNull();
    expect(await activeCount()).toBe(1);
    const history = await programmes.history(businessId, draft.id);
    expect(history.events.map((e) => e.eventType)).toEqual(['created', 'validated', 'activated']);
    expect(history.versions).toHaveLength(1);
    expect(await programmes.setupState(businessId)).toBe('configured');
  });

  it('earns under the active programme with provenance, applies a new version to FUTURE events only, and normalises the configuration', async () => {
    const member = await makeMember(businessId);
    const [programme] = await programmes.list(businessId);
    const first = await buy(member.accountId, 3, `p-${run}-1`);
    expect(first.account.points).toBe(6); // 3.00 x 2 per unit
    const ledger1 = (await admin.query(`select program_id, program_version, points from loyalty_transactions where loyalty_account_id=$1 and type='purchase'`, [member.accountId])).rows;
    expect(ledger1).toEqual([{ program_id: programme!.id, program_version: 1, points: 6 }]);
    const edited = await programmes.saveConfig(businessId, ownerId, programme!.id, { pointsPerCurrencyUnit: '3.50', pointsPerCheckin: 5 });
    expect(edited).toMatchObject({ status: 'active', currentVersion: 2 });
    expect(edited.config.pointsPerCurrencyUnit).toBe('3.50');
    const second = await buy(member.accountId, 3, `p-${run}-2`);
    expect(second.account.points).toBe(6 + 10); // floor(3.00 x 3.50) = 10
    const rows = (await admin.query(`select program_version, points from loyalty_transactions where loyalty_account_id=$1 and type='purchase' order by created_at`, [member.accountId])).rows;
    expect(rows).toEqual([{ program_version: 1, points: 6 }, { program_version: 2, points: 10 }]);
  });

  it('is idempotent: a replayed purchase awards once, and a changed replay is a conflict', async () => {
    const member = await makeMember(businessId);
    const a = await buy(member.accountId, 10, `idem-${run}`);
    const b = await buy(member.accountId, 10, `idem-${run}`);
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.account.points).toBe(a.account.points);
    await expect(buy(member.accountId, 11, `idem-${run}`)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const raced = await Promise.all(Array.from({ length: 5 }, () => buy(member.accountId, 4, `race-${run}`)));
    expect(raced.filter((r) => r.inserted)).toHaveLength(1);
    expect((await admin.query(`select count(*)::int n from loyalty_transactions where loyalty_account_id=$1 and type='purchase'`, [member.accountId])).rows[0].n).toBe(2);
  });

  it('switches programmes transactionally: balances kept, previous paused with history, exactly one active', async () => {
    const member = await makeMember(businessId);
    await buy(member.accountId, 5, `sw-${run}-1`);
    const balanceBefore = (await loyalty.getAccount(member.accountId, businessId)).points;
    const [current] = (await programmes.list(businessId)).filter((p) => p.status === 'active');
    await admin.query(
      `insert into loyalty_program_progress (business_id, program_id, loyalty_account_id, customer_id, counters)
       select $1, $2, a.id, a.customer_id, '{"stamps":3}'::jsonb from loyalty_accounts a where a.id=$3`,
      [businessId, current!.id, member.accountId],
    );
    const next = await draftAndValidate('LP-02', { pointsPerPurchase: 10, minimumPurchaseAmount: '5.00' });
    const { activated, previous } = await programmes.activate(businessId, ownerId, next.id);
    expect(activated.id).toBe(next.id);
    expect(previous).toMatchObject({ id: current!.id, status: 'inactive' });
    expect(await activeCount()).toBe(1);
    expect((await loyalty.getAccount(member.accountId, businessId)).points).toBe(balanceBefore); // balances untouched
    const frozen = (await admin.query(`select counters, frozen_at from loyalty_program_progress where program_id=$1 and loyalty_account_id=$2`, [current!.id, member.accountId])).rows[0];
    expect(frozen.counters).toEqual({ stamps: 3 }); // progress frozen, never converted
    expect(frozen.frozen_at).not.toBeNull();
    const events = (await programmes.history(businessId, current!.id)).events.map((e) => e.eventType);
    expect(events).toContain('switched_from');
    // The new programme earns per ITS rules.
    const small = await buy(member.accountId, 4, `sw-${run}-2`);
    expect(small.account.points).toBe(balanceBefore); // below the minimum: no points
    const big = await buy(member.accountId, 6, `sw-${run}-3`);
    expect(big.account.points).toBe(balanceBefore + 10);
    const notes = (await admin.query(`select notes from loyalty_transactions where loyalty_account_id=$1 and type='purchase' order by created_at desc limit 2`, [member.accountId])).rows;
    expect(notes.map((n) => n.notes)).toEqual([null, 'Did not qualify (BELOW_MINIMUM).']);
  });

  it('a FAILED switch rolls back completely and leaves the previous programme active', async () => {
    const before = (await programmes.list(businessId)).find((p) => p.status === 'active')!;
    const eventsBefore = (await programmes.history(businessId, before.id)).events.length;
    const target = await draftAndValidate('LP-03', { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 });
    await admin.query(`create or replace function lpc_fail_switch() returns trigger language plpgsql as $$ begin if new.event_type = 'switched_to' then raise exception 'injected failure'; end if; return new; end $$`);
    await admin.query(`create trigger lpc_fail_switch_trg before insert on loyalty_program_events for each row execute function lpc_fail_switch()`);
    try {
      await expect(programmes.activate(businessId, ownerId, target.id)).rejects.toThrow();
    } finally {
      await admin.query(`drop trigger lpc_fail_switch_trg on loyalty_program_events`);
      await admin.query(`drop function lpc_fail_switch()`);
    }
    const after = await programmes.list(businessId);
    expect(after.find((p) => p.status === 'active')?.id).toBe(before.id);
    expect(after.find((p) => p.id === target.id)?.status).toBe('validated');
    expect(await activeCount()).toBe(1);
    expect((await programmes.history(businessId, before.id)).events).toHaveLength(eventsBefore); // the half-done switch left no trace
    expect(after.find((p) => p.id === before.id)?.deactivatedAt).toBeNull();
  });

  it('concurrent activations stay safe: always exactly one active programme', async () => {
    const a = await draftAndValidate('LP-03', { pointsPerCurrencyUnit: '1', pointsPerCheckin: 1 });
    const b = await draftAndValidate('LP-03', { pointsPerCurrencyUnit: '2', pointsPerCheckin: 2 });
    const svcA = new LoyaltyProgramService(buildDb(raceA));
    const svcB = new LoyaltyProgramService(buildDb(raceB));
    const results = await Promise.allSettled([svcA.activate(businessId, ownerId, a.id), svcB.activate(businessId, ownerId, b.id)]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await activeCount()).toBe(1);
    const resolved = await resolveActiveProgramme(buildDb(admin), businessId);
    expect(resolved.kind).toBe('programme');
  });

  it('the database itself enforces one active programme, legal transitions, immutability and no deletion', async () => {
    const [active] = (await programmes.list(businessId)).filter((p) => p.status === 'active');
    const spare = await draftAndValidate('LP-03', { pointsPerCurrencyUnit: '4', pointsPerCheckin: 0 });
    await expect(admin.query(`update loyalty_programs set status='active' where id=$1`, [spare.id])).rejects.toThrow(/loyalty_programs_one_active_per_business|duplicate key/);
    const fresh = await programmes.createDraft(businessId, ownerId, { type: 'LP-03', config: { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 } });
    await expect(admin.query(`update loyalty_programs set status='active' where id=$1`, [fresh.id])).rejects.toThrow(/LOYALTY_PROGRAM_BAD_TRANSITION/);
    await expect(admin.query(`update loyalty_programs set type='LP-02' where id=$1`, [active!.id])).rejects.toThrow(/LOYALTY_PROGRAM_IMMUTABLE_FIELD/);
    await expect(admin.query(`delete from loyalty_programs where id=$1`, [active!.id])).rejects.toThrow(/LOYALTY_PROGRAM_NOT_DELETABLE/);
    await expect(admin.query(`update loyalty_program_versions set config='{}'::jsonb where program_id=$1`, [active!.id])).rejects.toThrow(/LOYALTY_PROGRAM_APPEND_ONLY/);
    await expect(admin.query(`delete from loyalty_program_events where program_id=$1`, [active!.id])).rejects.toThrow(/LOYALTY_PROGRAM_APPEND_ONLY/);
    await expect(admin.query(`truncate loyalty_programs cascade`)).rejects.toThrow();
    await expect(admin.query(`update loyalty_programs set current_version=current_version+1 where id=$1`, [active!.id])).rejects.toThrow(/LOYALTY_PROGRAM_NO_CONFIGURATION/);
  });

  it('keeps tenants apart: a programme cannot be read or changed through another business', async () => {
    const [any] = await programmes.list(businessId);
    await expect(programmes.get(otherBusinessId, any!.id)).rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND', status: 404 });
    await expect(programmes.saveConfig(otherBusinessId, ownerId, any!.id, { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 })).rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND' });
    await expect(programmes.activate(otherBusinessId, ownerId, any!.id)).rejects.toMatchObject({ code: 'PROGRAM_NOT_FOUND' });
    // A progress row cannot point a programme of one business at an account of another.
    const foreign = await makeMember(otherBusinessId);
    await expect(
      admin.query(`insert into loyalty_program_progress (business_id, program_id, loyalty_account_id, customer_id) select $1, $2, a.id, a.customer_id from loyalty_accounts a where a.id=$3`, [businessId, any!.id, foreign.accountId]),
    ).rejects.toThrow(/LOYALTY_PROGRAM_TENANT_MISMATCH/);
  });

  it('Configure Later: a business created through registration can enrol and be served but earns nothing until a programme is active', async () => {
    const later = (await new BusinessService(appDbOf(buildDb(admin))).createBusiness({ name: `LPC later ${run}` } as never, ownerId)).businessId;
    expect(await programmes.setupState(later)).toBe('pending'); // set by registration itself, with no extra call
    const member = await makeMember(later);
    const result = await buy(member.accountId, 20, `later-${run}`, later);
    expect(result.account.points).toBe(0);
    const note = (await admin.query(`select notes, program_id from loyalty_transactions where loyalty_account_id=$1`, [member.accountId])).rows[0];
    expect(note).toEqual({ notes: 'No active loyalty programme: this purchase earned nothing.', program_id: null });
    const draft = await draftAndValidate('LP-03', { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 }, later);
    await programmes.activate(later, ownerId, draft.id);
    expect((await buy(member.accountId, 20, `later2-${run}`, later)).account.points).toBe(20);
  });

  it('an existing business with no programme row keeps earning exactly as before (implicit legacy), including settings edits', async () => {
    const legacyBusiness = (await repos.businesses.create({ name: `LPC legacy ${run}`, slug: `lpc-legacy-${run}` })).id;
    await repos.loyaltySettings.update(legacyBusiness, { pointsPerCurrencyUnit: '1.50' }, ownerId).catch(async () => {
      await repos.loyaltySettings.getOrCreateDefaults(legacyBusiness);
      await repos.loyaltySettings.update(legacyBusiness, { pointsPerCurrencyUnit: '1.50' }, ownerId);
    });
    expect((await resolveActiveProgramme(buildDb(admin), legacyBusiness)).kind).toBe('implicit_legacy');
    const member = await makeMember(legacyBusiness);
    expect((await buy(member.accountId, 3, `leg-${run}`, legacyBusiness)).account.points).toBe(4); // floor(4.5)
    const row = (await admin.query(`select program_id, program_version from loyalty_transactions where loyalty_account_id=$1 and type='purchase'`, [member.accountId])).rows[0];
    expect(row).toEqual({ program_id: null, program_version: null });
  });

  it('a backfilled LEGACY programme follows the existing settings screen as new versions (future events only)', async () => {
    const business = (await repos.businesses.create({ name: `LPC backfilled ${run}`, slug: `lpc-bf-${run}` })).id;
    await repos.loyaltySettings.getOrCreateDefaults(business);
    await repos.loyaltySettings.update(business, { pointsPerCurrencyUnit: '2.00' }, ownerId);
    // The migration's backfill, applied to this one business.
    const programId = (
      await admin.query(
        `insert into loyalty_programs (business_id, type, status, current_version, legacy, activated_at) values ($1,'LP-03','active',1,true,now()) returning id`,
        [business],
      )
    ).rows[0].id;
    await admin.query(`insert into loyalty_program_versions (program_id, business_id, version, config, config_hash) values ($1,$2,1,'{"pointsPerCurrencyUnit":"2.00","pointsPerCheckin":10,"rounding":"floor","legacy":true}'::jsonb,'x')`, [programId, business]);
    const member = await makeMember(business);
    expect((await buy(member.accountId, 3, `bf-${run}-1`, business)).account.points).toBe(6);
    expect(await programmes.syncLegacySettings(business, ownerId, { pointsPerCurrencyUnit: '5.00', pointsPerCheckin: 10 })).toBe(true);
    expect((await buy(member.accountId, 3, `bf-${run}-2`, business)).account.points).toBe(6 + 15);
    const versions = (await admin.query(`select program_version, points from loyalty_transactions where loyalty_account_id=$1 and type='purchase' order by created_at`, [member.accountId])).rows;
    expect(versions).toEqual([{ program_version: 1, points: 6 }, { program_version: 2, points: 15 }]);
  });

  it('refuses amounts the currency or the ledger cannot hold exactly instead of rounding them', async () => {
    const kwd = (await repos.businesses.create({ name: `LPC kwd ${run}`, slug: `lpc-kwd-${run}`, defaultCurrency: 'KWD' } as never)).id;
    await repos.loyaltySettings.getOrCreateDefaults(kwd);
    const member = await makeMember(kwd);
    await expect(buy(member.accountId, 1.005, `kwd-${run}-1`, kwd)).rejects.toMatchObject({ code: 'AMOUNT_PRECISION_NOT_SUPPORTED', status: 422 });
    await expect(buy(member.accountId, 1.0001, `kwd-${run}-2`, kwd)).rejects.toMatchObject({ code: 'INVALID_PURCHASE_AMOUNT', status: 422 });
    expect((await buy(member.accountId, 1.5, `kwd-${run}-3`, kwd)).account.points).toBe(1); // floor(1.500 x 1)
    const usd = await makeMember(businessId);
    await expect(buy(usd.accountId, 9.999, `usd-${run}`)).rejects.toMatchObject({ code: 'INVALID_PURCHASE_AMOUNT' });
    await expect(buy(usd.accountId, 0.1 + 0.2, `usd2-${run}`)).rejects.toMatchObject({ code: 'INVALID_PURCHASE_AMOUNT' });
  });

  it('paused programmes earn nothing, a retired programme is final, and the active one cannot be retired directly', async () => {
    const active = (await programmes.list(businessId)).find((p) => p.status === 'active')!;
    await expect(programmes.retire(businessId, ownerId, active.id)).rejects.toMatchObject({ code: 'PROGRAM_STILL_ACTIVE' });
    await expect(programmes.deactivate(businessId, managerId, active.id)).rejects.toMatchObject({ code: 'PROGRAM_OWNER_REQUIRED' });
    await programmes.deactivate(businessId, ownerId, active.id);
    expect((await resolveActiveProgramme(buildDb(admin), businessId)).kind).toBe('none');
    const member = await makeMember(businessId);
    expect((await buy(member.accountId, 10, `paused-${run}`)).account.points).toBe(0);
    await programmes.retire(businessId, ownerId, active.id);
    await expect(programmes.saveConfig(businessId, ownerId, active.id, { pointsPerCurrencyUnit: '1', pointsPerCheckin: 0 })).rejects.toMatchObject({ code: 'PROGRAM_NOT_EDITABLE' });
    await expect(programmes.activate(businessId, ownerId, active.id)).rejects.toMatchObject({ code: 'PROGRAM_NOT_ACTIVATABLE' });
  });
});
