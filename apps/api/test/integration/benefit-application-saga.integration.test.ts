import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { BenefitApplicationSagaService, BenefitSagaError, type IntentView } from '../../src/billing/benefit-application.saga.service';
import type { ProviderObservation } from '../../src/billing/invoice-benefit-application.saga';

/**
 * Split 08 durable benefit-application saga on PostgreSQL (migration 0048), in a SCRATCH database created and dropped here on the disposable server
 * named by DATABASE_URL. Fixture parents (settlement/decision/lot/account/reservation rows) are forged on one connection with foreign keys and the
 * 0041/0042 write denials disabled, because no real consumption path exists; every service call then runs on its own connection with all constraints
 * and triggers (except the saga's inert guard, disabled after the "inert by default" test) active. No provider, Stripe, Neon or production resource.
 */
describe.skipIf(!process.env.DATABASE_URL)('Split 08 durable benefit saga (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_saga_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const SAGA_TABLES = ['benefit_application_intents', 'benefit_provider_attempts', 'benefit_provider_observations', 'benefit_application_compensations', 'benefit_application_transitions'];
  const clients: Client[] = [];
  let admin: Client;
  let fx: Client;
  const rows = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await admin.query<T>(sql, params)).rows;
  const newService = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return new BenefitApplicationSagaService(buildDb(c)); };
  let svc: BenefitApplicationSagaService;
  let tenantA: string;
  let tenantB: string;
  let seq = 0;

  const makeReservation = async (businessId: string, over: { expiresInMs?: number; state?: string } = {}) => {
    const n = ++seq;
    const account = (await fx.query<{ id: string }>('insert into partner_credit_accounts(business_id) values($1) on conflict (business_id) do update set business_id=excluded.business_id returning id', [businessId])).rows[0]!.id;
    const decision = (await fx.query<{ id: string }>(
      `insert into partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key)
       values(gen_random_uuid(),$1,gen_random_uuid(),'vested',1,'2026-10',now(),now(),$2) returning id`, [businessId, `s08-fx-${dbName}-${n}`])).rows[0]!.id;
    const lot = (await fx.query<{ id: string }>(`insert into partner_credit_lots(decision_id,account_id,units,available_units,status,vest_at,expires_at) values($1,$2,1,0,'reserved',now(),now()+interval '1 year') returning id`, [decision, account])).rows[0]!.id;
    const exp = new Date(Date.now() + (over.expiresInMs ?? 86_400_000));
    const reservation = (await fx.query<{ id: string }>(
      `insert into partner_credit_reservations(business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at,state,terminal_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [businessId, decision, lot, account, `intent-${n}`, `res-key-${dbName}-${n}`, exp, over.state ?? 'reserved', over.state && over.state !== 'reserved' ? new Date() : null])).rows[0]!.id;
    return reservation;
  };
  const terms = (n = 1) => ({ invoiceRef: `in_${n}`, expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' });
  const newIntent = async (businessId = tenantA, n = ++seq) => svc.createIntent({ reservationId: await makeReservation(businessId), ...terms(n) });
  const matched = (i: IntentView, ref = `ef_${randomBytes(4).toString('hex')}`): ProviderObservation => ({ status: 'effect_present', effectRef: ref, amountMinor: i.expectedBenefitMinor, currency: i.currency, invoiceRef: i.invoiceRef, attributedToReservationRef: i.reservationId });
  const okResult = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { if (!r.ok) throw new Error('expected ok, got ' + JSON.stringify(r)); return r as Extract<T, { ok: true }>; };
  /** The credit-side rows of ONE reservation (its lot and account), the ledger size and the reservation state: the saga must leave all of them alone. */
  const creditSnapshot = async (reservationId: string) => JSON.stringify(await rows(
    `select (select count(*) from partner_credit_ledger) ledger, r.state reservation, l.status lot, l.available_units, a.available, a.provisional, a.reserved, a.recovery_due
       from partner_credit_reservations r join partner_credit_lots l on l.id=r.lot_id join partner_credit_accounts a on a.id=r.account_id where r.id=$1`, [reservationId]));

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`create database ${dbName}`);
    const m = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed');
    await admin.end();
    admin = new Client({ connectionString: urlFor(dbName) });
    await admin.connect();
    // Fixture connection: forged parents. Disposable database only.
    fx = new Client({ connectionString: urlFor(dbName) });
    await fx.connect();
    clients.push(fx);
    for (const [t, g] of [['partner_credit_award_decisions', 'partner_credit_awards_insert_disabled'], ['partner_credit_lots', 'partner_credit_lots_inert_guard'], ['partner_credit_accounts', 'partner_credit_accounts_inert_guard'], ['partner_credit_reservations', 'partner_credit_reservations_inert_guard']])
      await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ${g}`);
    await fx.query('SET session_replication_role = replica');
    tenantA = (await rows<{ id: string }>("insert into businesses(name,slug,status) values('S08 saga A',$1,'active') returning id", [`s08-a-${dbName}`]))[0]!.id;
    tenantB = (await rows<{ id: string }>("insert into businesses(name,slug,status) values('S08 saga B',$1,'active') returning id", [`s08-b-${dbName}`]))[0]!.id;
    svc = await newService();
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    if (admin) await admin.end().catch(() => undefined);
    const a = new Client({ connectionString: urlFor('postgres') });
    await a.connect();
    await a.query(`drop database if exists ${dbName} with (force)`);
    await a.end();
  }, 120_000);

  it('is inert by default: with the saga guard enabled no saga row can be written, even through the service', async () => {
    const reservation = await makeReservation(tenantA);
    try {
      const err = await svc.createIntent({ reservationId: reservation, ...terms(900) }).then(() => null, (e: { message?: string; cause?: { message?: string } }) => e); // drizzle wraps the driver error
      expect(err).not.toBeNull();
      expect(`${err?.message} ${err?.cause?.message}`).toMatch(/writes disabled pending financial activation/);
      expect((await rows('select count(*)::int n from benefit_application_intents'))[0]!.n).toBe(0);
    } finally {
      for (const t of SAGA_TABLES) await admin.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_inert_guard`);
    }
  });

  it('createIntent validates the reservation, is idempotent for identical terms, refuses different terms', async () => {
    const reservation = await makeReservation(tenantA);
    const a = await svc.createIntent({ reservationId: reservation, ...terms(10) });
    const b = await svc.createIntent({ reservationId: reservation, ...terms(10) });
    expect(b.id).toBe(a.id);
    expect(a).toMatchObject({ state: 'reserved', outcome: 'pending', businessId: tenantA, units: 1 });
    await expect(svc.createIntent({ reservationId: reservation, ...terms(10), expectedBenefitMinor: 301 })).rejects.toMatchObject({ code: 'INTENT_CONFLICT' });
    await expect(svc.createIntent({ reservationId: crypto.randomUUID(), ...terms(11) })).rejects.toMatchObject({ code: 'RESERVATION_NOT_FOUND' });
    await expect(svc.createIntent({ reservationId: await makeReservation(tenantA, { expiresInMs: -1000 }), ...terms(12) })).rejects.toMatchObject({ code: 'RESERVATION_EXPIRED' });
    await expect(svc.createIntent({ reservationId: await makeReservation(tenantA, { state: 'released' }), ...terms(13) })).rejects.toMatchObject({ code: 'RESERVATION_NOT_RESERVED' });
    await expect(svc.createIntent({ reservationId: await makeReservation(tenantA), ...terms(14), expectedBenefitMinor: 0 })).rejects.toBeInstanceOf(BenefitSagaError);
    expect((await rows('select count(*)::int n from benefit_application_intents where reservation_id=$1', [reservation]))[0]!.n).toBe(1);
  });

  it('reserved -> applying -> consumed on a matched provider effect, with the full audit trail and no credit movement', async () => {
    const i = await newIntent();
    const before = await creditSnapshot(i.reservationId);
    const begin = okResult(await svc.beginApply(i.id, 'att-1', new Date(1_000)));
    expect(begin.intent).toMatchObject({ state: 'applying', outcome: 'pending', attemptKey: 'att-1' });
    const done = okResult(await svc.recordObservation(i.id, 'att-1', matched(i, 'ef_main'), new Date(2_000)));
    expect(done.intent).toMatchObject({ state: 'consumed', outcome: 'confirmed', providerEffectRef: 'ef_main' });
    expect(done.effects.map(e => e.type)).toEqual(['consume']);
    expect((await rows<{ provider_idempotency_key: string }>('select provider_idempotency_key from benefit_provider_attempts where intent_id=$1', [i.id]))[0]!.provider_idempotency_key).toBe(`benefit-apply:v1:${i.reservationId}`);
    expect(await rows('select classification, effect_ref from benefit_provider_observations where intent_id=$1', [i.id])).toEqual([{ classification: 'matched', effect_ref: 'ef_main' }]);
    expect((await rows<{ from_state: string; to_state: string; replay: boolean }>('select from_state,to_state,replay from benefit_application_transitions where intent_id=$1 order by seq', [i.id])).map(r => `${r.from_state}>${r.to_state}:${r.replay}`)).toEqual(['reserved>applying:false', 'applying>consumed:false']);
    expect(await creditSnapshot(i.reservationId)).toBe(before); // the saga moves no credit: reservation, lot, account and ledger are as they were
  });

  it('replays are idempotent: same attempt, same observation and late observations add no state change and no duplicate evidence', async () => {
    const i = await newIntent();
    okResult(await svc.beginApply(i.id, 'a', new Date(10)));
    const again = okResult(await svc.beginApply(i.id, 'a', new Date(11)));
    expect(again.replay).toBe(true);
    const obs = matched(i, 'ef_replay');
    okResult(await svc.recordObservation(i.id, 'a', obs, new Date(20)));
    const r2 = okResult(await svc.recordObservation(i.id, 'a', obs, new Date(21)));
    expect(r2).toMatchObject({ replay: true, effects: [] });
    expect((await rows('select count(*)::int n from benefit_provider_attempts where intent_id=$1', [i.id]))[0]!.n).toBe(1);
    expect((await rows('select count(*)::int n from benefit_provider_observations where intent_id=$1', [i.id]))[0]!.n).toBe(1);
    expect((await rows('select version from benefit_application_intents where id=$1', [i.id]))[0]!.version).toBe(3); // created, applying, consumed
  });

  it('a mismatching, unattributed or unreachable provider answer never consumes: explicit disputed/unresolved outcomes, then a later match consumes', async () => {
    const cases: Array<[string, (i: IntentView) => ProviderObservation, string, string]> = [
      ['wrong amount', i => ({ ...matched(i), amountMinor: 1 }), 'PROVIDER_EFFECT_MISMATCH', 'disputed'],
      ['other reservation', i => ({ ...matched(i), attributedToReservationRef: crypto.randomUUID() }), 'PROVIDER_EFFECT_MISMATCH', 'disputed'],
      ['no attribution', i => ({ ...matched(i), attributedToReservationRef: null }), 'PROVIDER_EFFECT_UNATTRIBUTED', 'disputed'],
      ['unreachable', () => ({ status: 'unreachable' }), 'PROVIDER_UNREACHABLE', 'unresolved'],
    ];
    for (const [, obs, cause, outcome] of cases) {
      const i = await newIntent();
      okResult(await svc.beginApply(i.id, 'k', new Date(100)));
      const r = okResult(await svc.recordObservation(i.id, 'k', obs(i), new Date(200)));
      expect(r.intent).toMatchObject({ state: 'retained', cause, outcome });
      expect((await rows('select count(*)::int n from partner_credit_reservations where id=$1 and state=\'reserved\'', [i.reservationId]))[0]!.n).toBe(1);
      expect(okResult(await svc.recordObservation(i.id, 'k', matched(i), new Date(300))).intent).toMatchObject({ state: 'consumed', outcome: 'confirmed' });
    }
  });

  it('release only on provider-confirmed absence queried AFTER the attempt; a stale absence is held', async () => {
    const i = await newIntent();
    okResult(await svc.beginApply(i.id, 'k', new Date(5_000)));
    const stale = okResult(await svc.recordObservation(i.id, 'k', { status: 'effect_absent', checkedAt: 4_999 }, new Date(5_100)));
    expect(stale.intent).toMatchObject({ state: 'retained', cause: 'STALE_ABSENCE', outcome: 'unresolved' });
    const fresh = okResult(await svc.recordObservation(i.id, 'k', { status: 'effect_absent', checkedAt: 5_001 }, new Date(5_200)));
    expect(fresh.intent).toMatchObject({ state: 'released', cause: 'PROVIDER_CONFIRMED_NO_EFFECT', outcome: 'rejected' });
    expect((await rows<{ classification: string }>('select classification from benefit_provider_observations where intent_id=$1 order by recorded_at', [i.id])).map(r => r.classification)).toEqual(['absent_stale', 'absent_confirmed']);
  });

  it('reversals: before an attempt releases; during an attempt holds and compensates if confirmed; after consumption appends exactly one negative entry per reference', async () => {
    const early = await newIntent();
    expect(okResult(await svc.reverse(early.id, 'rv-early', new Date(1))).intent).toMatchObject({ state: 'released', cause: 'REVERSED_BEFORE_APPLICATION' });

    const mid = await newIntent();
    okResult(await svc.beginApply(mid.id, 'k', new Date(10)));
    const held = okResult(await svc.reverse(mid.id, 'rv-mid', new Date(11)));
    expect(held.intent).toMatchObject({ state: 'retained', cause: 'REVERSAL_DURING_APPLICATION', outcome: 'disputed' });
    const confirmed = okResult(await svc.recordObservation(mid.id, 'k', matched(mid), new Date(12)));
    expect(confirmed.effects.map(e => e.type)).toEqual(['consume', 'append_compensation']);
    expect(await rows('select reversal_ref, units, benefit_minor from benefit_application_compensations where intent_id=$1', [mid.id])).toEqual([{ reversal_ref: 'rv-mid', units: -1, benefit_minor: -300 }]);

    const late = await newIntent();
    okResult(await svc.beginApply(late.id, 'k', new Date(10)));
    okResult(await svc.recordObservation(late.id, 'k', matched(late), new Date(11)));
    const c1 = okResult(await svc.reverse(late.id, 'rv-1', new Date(12)));
    expect(c1.effects).toHaveLength(1);
    expect(okResult(await svc.reverse(late.id, 'rv-1', new Date(13)))).toMatchObject({ replay: true, effects: [] });
    expect(okResult(await svc.reverse(late.id, 'rv-2', new Date(14))).effects).toHaveLength(1);
    expect((await rows('select count(*)::int n from benefit_application_compensations where intent_id=$1', [late.id]))[0]!.n).toBe(2);
    expect((await rows('select state from benefit_application_intents where id=$1', [late.id]))[0]!.state).toBe('consumed'); // history is never edited
  });

  it('concurrency: of many simultaneous attempts exactly one starts; duplicate confirmations consume once; one provider effect settles one reservation', async () => {
    const i = await newIntent();
    const services = await Promise.all(Array.from({ length: 8 }, () => newService()));
    const attempts = await Promise.all(services.map((s, k) => s.beginApply(i.id, `att-${k}`, new Date(10))));
    expect(attempts.filter(r => r.ok && !r.replay)).toHaveLength(1);
    expect(attempts.filter(r => !r.ok && r.code === 'ATTEMPT_CONFLICT')).toHaveLength(7);
    expect((await rows('select count(*)::int n from benefit_provider_attempts where intent_id=$1', [i.id]))[0]!.n).toBe(1);
    const key = (await rows<{ attempt_key: string }>('select attempt_key from benefit_provider_attempts where intent_id=$1', [i.id]))[0]!.attempt_key;
    const obs = matched(i, 'ef_conc');
    const confirms = await Promise.all(services.map(s => s.recordObservation(i.id, key, obs, new Date(20))));
    expect(confirms.every(r => r.ok)).toBe(true);
    expect(confirms.filter(r => r.ok && !r.replay)).toHaveLength(1);
    expect((await rows('select count(*)::int n from benefit_application_transitions where intent_id=$1 and to_state=\'consumed\' and replay=false', [i.id]))[0]!.n).toBe(1);

    // one provider effect cannot settle two reservations
    const x = await newIntent();
    const y = await newIntent();
    okResult(await svc.beginApply(x.id, 'k', new Date(30)));
    okResult(await svc.beginApply(y.id, 'k', new Date(30)));
    const shared = 'ef_shared';
    const [rx, ry] = await Promise.all([services[0]!.recordObservation(x.id, 'k', { ...matched(x, shared) }, new Date(40)), services[1]!.recordObservation(y.id, 'k', { ...matched(y, shared) }, new Date(40))]);
    const states = [okResult(rx).intent.state, okResult(ry).intent.state].sort();
    expect(states).toEqual(['consumed', 'retained']);
    expect((await rows('select count(*)::int n from benefit_application_intents where provider_effect_ref=$1', [shared]))[0]!.n).toBe(1);
  });

  it('crash recovery: an attempt abandoned mid-flight is found by a fresh service and resolved without a second attempt', async () => {
    const i = await newIntent();
    okResult(await svc.beginApply(i.id, 'crashed', new Date(Date.now() - 3_600_000)));
    await admin.query("update benefit_application_intents set updated_at = now() - interval '2 hours' where id=$1", [i.id]).catch(() => undefined);
    const fresh = await newService();
    const stuck = await fresh.findUnresolved(new Date(Date.now() - 60_000), 500);
    expect(stuck.map(s => s.id)).toContain(i.id);
    expect(okResult(await fresh.beginApply(i.id, 'crashed', new Date())).replay).toBe(true);
    expect(await fresh.beginApply(i.id, 'second-process', new Date())).toMatchObject({ ok: false, code: 'ATTEMPT_CONFLICT' });
    expect(okResult(await fresh.recordObservation(i.id, 'crashed', matched(i), new Date())).intent.state).toBe('consumed');
    expect((await fresh.findUnresolved(new Date(Date.now() + 60_000), 500)).map(s => s.id)).not.toContain(i.id);
  });

  it('tenant isolation is database-enforced: a child row cannot name another business than its intent, nor an intent another business than its reservation', async () => {
    const reservationA = await makeReservation(tenantA);
    await expect(admin.query(
      `insert into benefit_application_intents(business_id,reservation_id,invoice_ref,expected_benefit_minor,currency,policy_version) values($1,$2,'in_x',300,'usd','PC-BENEFIT/1')`, [tenantB, reservationA]))
      .rejects.toMatchObject({ code: '23503', constraint: 'benefit_application_intents_reservation_business_fk' });
    const i = await newIntent(tenantA);
    await expect(admin.query(
      `insert into benefit_provider_attempts(intent_id,business_id,attempt_key,provider_idempotency_key,started_at) values($1,$2,'x','idem-x',now())`, [i.id, tenantB]))
      .rejects.toMatchObject({ code: '23503', constraint: 'benefit_provider_attempts_intent_business_fk' });
    await expect(admin.query(
      `insert into benefit_application_compensations(intent_id,business_id,reversal_ref,units,benefit_minor,idempotency_key) values($1,$2,'r',-1,-300,'k-x')`, [i.id, tenantB]))
      .rejects.toMatchObject({ code: '23503' });
  });

  it('the database refuses inconsistent saga rows and any mutation of append-only evidence', async () => {
    const i = await newIntent();
    await expect(admin.query("update benefit_application_intents set state='consumed', outcome='confirmed' where id=$1", [i.id])).rejects.toMatchObject({ code: '23514', constraint: 'benefit_application_intents_shape_check' });
    await expect(admin.query("update benefit_application_intents set state='released', outcome='pending', cause='x' where id=$1", [i.id])).rejects.toMatchObject({ code: '23514' });
    okResult(await svc.beginApply(i.id, 'k', new Date(1)));
    okResult(await svc.recordObservation(i.id, 'k', matched(i), new Date(2)));
    okResult(await svc.reverse(i.id, 'rv', new Date(3)));
    for (const t of ['benefit_provider_attempts', 'benefit_provider_observations', 'benefit_application_compensations', 'benefit_application_transitions']) {
      await expect(admin.query(`update ${t} set recorded_at = now() ${t === 'benefit_application_compensations' ? ', created_at = now()' : ''} where intent_id=$1`.replace(', created_at = now()', '').replace('recorded_at = now()', t === 'benefit_application_compensations' ? 'reversal_ref = reversal_ref' : 'recorded_at = recorded_at'), [i.id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`delete from ${t} where intent_id=$1`, [i.id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`truncate ${t}`)).rejects.toThrow(/append-only/);
    }
    // one provider effect id can never be stored on two intents, whatever the service does
    const other = await newIntent();
    await admin.query("update benefit_application_intents set state='applying', attempt_key='k', attempted_at=now() where id=$1", [other.id]);
    const eff = (await rows<{ provider_effect_ref: string }>('select provider_effect_ref from benefit_application_intents where id=$1', [i.id]))[0]!.provider_effect_ref;
    await expect(admin.query("update benefit_application_intents set state='consumed', outcome='confirmed', provider_effect_ref=$2, applied_at=now() where id=$1", [other.id, eff])).rejects.toMatchObject({ code: '23505' });
  });

  it('the existing financial guards and the reservation/application denials are untouched by 0048', async () => {
    const g = await rows<{ tgname: string; tgenabled: string }>("select tgname, tgenabled from pg_trigger where tgname in ('partner_credit_lots_inert_guard','partner_credit_ledger_insert_disabled','partner_credit_reservations_inert_guard','pc_multiunit_allocation_inert_guard','pc_multiunit_movement_inert_guard','billing_partner_credit_applications_inert_guard') order by 1");
    expect(g).toHaveLength(6);
    // the reservation and lots guards were disabled by this test's fixture setup on this scratch database only; the others are untouched
    expect(g.filter(x => !['partner_credit_lots_inert_guard', 'partner_credit_reservations_inert_guard'].includes(x.tgname)).every(x => x.tgenabled === 'O')).toBe(true);
  });
});
