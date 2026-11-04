import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TRUNCATE denial for the frozen Split 07/08 financial evidence tables (migration 0054), in a SCRATCH database created and dropped here on the disposable
 * server named by DATABASE_URL, with every migration applied. Row-level write guards do not fire for TRUNCATE, so these tests prove the statement-level
 * denial directly: plain, CASCADE, RESTART IDENTITY, under session_replication_role = replica, atomically through a cascade from a parent table, and that
 * no future immutable-evidence table can ship without one. Nothing here touches Stripe, Neon or a production resource.
 */
const PROTECTED = [
  'benefit_application_intents', 'billing_partner_credit_applications', 'partner_credit_accounts', 'partner_credit_award_decisions', 'partner_credit_ledger',
  'partner_credit_lots', 'partner_credit_multiunit_lot_allocations', 'partner_credit_multiunit_movements', 'partner_credit_recovery_obligations',
  'partner_credit_reservations', 'stripe_subscription_tier_observations', 'partner_credit_policies',
] as const;
/** Truncate-only triggers from earlier migrations (0045, 0048, 0049, 0050, 0051): untouched except that 0054 makes them ENABLE ALWAYS. */
const LEGACY = [
  'benefit_application_compensations', 'benefit_application_transitions', 'benefit_provider_attempts', 'benefit_provider_observations', 'benefit_reconciliation_attempts',
  'heta_provenance_comparisons', 'heta_reconciliation_work', 'heta_record_revisions', 'partner_credit_award_disputes', 'partner_credit_corrections', 'partner_credit_dispute_events',
  'stripe_evidence_control_events', 'stripe_evidence_keys', 'stripe_provider_event_conflicts', 'stripe_provider_event_dispositions', 'stripe_provider_events', 'stripe_provider_malformed_receipts',
] as const;
/** Tables with a row trigger that are NOT frozen financial evidence; a new guarded table must either get a truncate trigger or be added here deliberately. */
const NOT_EVIDENCE = ['business_subscriptions', 'feedback'] as const;

describe.skipIf(!process.env.DATABASE_URL)('Split 07/08 financial TRUNCATE denial (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_trunc_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const clients: Client[] = [];
  let admin: Client;
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const errText = (e: unknown) => String((e as Error)?.message ?? e);
  const rejects = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return errText(e); } };
  const count = async (c: Client, t: string) => Number((await c.query(`select count(*)::int n from ${t}`)).rows[0].n);

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed');
    admin = await connect();
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`drop database if exists ${dbName} with (force)`); await root.end();
  });

  it('every protected table has a BEFORE TRUNCATE statement trigger that is ENABLE ALWAYS, and so does every earlier truncate-only trigger', async () => {
    const r = await admin.query<{ t: string; enabled: string; stmt: boolean }>(
      `select tgrelid::regclass::text t, tgenabled::text enabled, (tgtype & 1) = 0 stmt from pg_trigger
        where not tgisinternal and (tgtype & 32) = 32 and (tgtype & 2) = 2 and tgrelid::regclass::text = any($1)`, [[...PROTECTED, ...LEGACY]]);
    expect(r.rows.map(x => x.t).sort()).toEqual([...PROTECTED, ...LEGACY].sort());
    for (const row of r.rows) { expect(row.enabled, row.t).toBe('A'); expect(row.stmt, row.t).toBe(true); }
  });

  it('structural guard: every table with a row-level write guard has a BEFORE TRUNCATE trigger, except the two named non-evidence tables', async () => {
    const r = await admin.query<{ t: string }>(
      `select distinct g.tgrelid::regclass::text t from pg_trigger g
        where not g.tgisinternal and (g.tgtype & 32) = 0
          and not exists (select 1 from pg_trigger x where x.tgrelid = g.tgrelid and not x.tgisinternal and (x.tgtype & 32) = 32)
        order by 1`);
    expect(r.rows.map(x => x.t).filter(t => !(NOT_EVIDENCE as readonly string[]).includes(t))).toEqual([]);
  });

  /** Runs `truncate <table> cascade` with every OTHER table's truncate trigger disabled (inside a rolled-back transaction), so only the table's own trigger can deny it. */
  async function ownTriggerDenial(table: string, replica: boolean) {
    const c = await connect();
    await c.query('begin');
    try {
      if (replica) await c.query('SET LOCAL session_replication_role = replica');
      const others = await c.query<{ t: string; n: string }>(
        `select tgrelid::regclass::text t, tgname n from pg_trigger where not tgisinternal and (tgtype & 32) = 32 and tgrelid::regclass::text <> $1`, [table]);
      for (const o of others.rows) await c.query(`alter table ${o.t} disable trigger ${o.n}`);
      return await rejects(c.query(`truncate ${table} cascade`));
    } finally { await c.query('rollback'); await c.end(); }
  }
  for (const table of [...PROTECTED, ...LEGACY]) {
    it(`${table}: its own truncate trigger denies TRUNCATE ... CASCADE, in a normal and a replica-role session, with every other table's trigger disabled`, async () => {
      const isNew = (PROTECTED as readonly string[]).includes(table);
      const check = (msg: string, label: string) => {
        if (isNew) expect(msg, label).toMatch(new RegExp(`FINANCIAL_EVIDENCE_TRUNCATE_DENIED \\(${table}\\)`));
        // an earlier trigger raises its own message: it must be a raised denial, never PostgreSQL's foreign-key rule, a permission error or a success
        else { expect(msg, label).not.toBe(''); expect(msg, label).not.toMatch(/referenced in a foreign key|permission denied|must be owner/i); }
      };
      check(await ownTriggerDenial(table, false), `${table} normal`);
      check(await ownTriggerDenial(table, true), `${table} replica`);
    });
  }

  it('pins the one documented exception: the only truncate triggers that are not ENABLE ALWAYS are the two 0052 allocation triggers', async () => {
    const r = await admin.query<{ t: string; n: string }>(
      `select tgrelid::regclass::text t, tgname n from pg_trigger where not tgisinternal and (tgtype & 32) = 32 and tgenabled <> 'A' order by 1`);
    expect(r.rows.map(x => `${x.t}:${x.n}`)).toEqual(['s08_allocation_freeze_items:s08_allocation_child_deny', 's08_allocation_freezes:s08_allocation_parent_deny']);
    // still denied in a normal session; the replica-role gap is a documented follow-up (their fixtures forge rows on a replica-role connection)
    const c = await connect();
    for (const t of ['s08_allocation_freezes', 's08_allocation_freeze_items']) expect(await rejects(c.query(`truncate ${t} cascade`)), t).toMatch(/S08_ALLOCATION_INERT|FINANCIAL_EVIDENCE_TRUNCATE_DENIED|append-only/);
  });

  // A plain TRUNCATE of a table that foreign keys reference is also refused by PostgreSQL itself, before any trigger runs; CASCADE (and the replica-role
  // session, where FK triggers are off but that static rule still applies) is what reaches the triggers, and every table in the cascade set carries a denial.
  const DENIED = /FINANCIAL_EVIDENCE_TRUNCATE_DENIED|append-only|S08_ALLOCATION_INERT|cannot truncate a table referenced/;
  const TRIGGER_DENIED = /FINANCIAL_EVIDENCE_TRUNCATE_DENIED|append-only|S08_ALLOCATION_INERT/;
  for (const table of PROTECTED) {
    it(`TRUNCATE ${table} is denied (plain, CASCADE, RESTART IDENTITY), also from a replica-role session`, async () => {
      const c = await connect();
      expect(await rejects(c.query(`truncate ${table}`)), `truncate ${table}`).toMatch(DENIED);
      for (const sql of [`truncate ${table} cascade`, `truncate ${table} restart identity cascade`])
        expect(await rejects(c.query(sql)), sql).toMatch(TRIGGER_DENIED);
      const replica = await connect();
      await replica.query('SET session_replication_role = replica');
      expect(await rejects(replica.query(`truncate ${table} cascade`)), 'replica role').toMatch(TRIGGER_DENIED);
    });
  }

  it('the new trigger itself fires for a table that nothing references (plain TRUNCATE, normal and replica-role sessions)', async () => {
    for (const table of ['partner_credit_ledger', 'stripe_subscription_tier_observations']) {
      const normal = await connect();
      expect(await rejects(normal.query(`truncate ${table}`)), table).toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED/);
      const replica = await connect();
      await replica.query('SET session_replication_role = replica');
      expect(await rejects(replica.query(`truncate ${table}`)), `${table} replica`).toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED/);
    }
  });

  it('a TRUNCATE that reaches these tables through a parent CASCADE fails as a whole and removes nothing', async () => {
    const fx = await connect();
    await fx.query('SET session_replication_role = replica'); // fixture rows only: the write guards are bypassed on this connection, never in the denial test itself
    const businessId = (await fx.query<{ id: string }>("insert into businesses(name,slug,status) values('Trunc','trunc-" + dbName + "','active') returning id")).rows[0]!.id;
    await fx.query('insert into partner_credit_accounts(business_id) values($1)', [businessId]);
    const before = { b: await count(admin, 'businesses'), a: await count(admin, 'partner_credit_accounts') };
    expect(before.a).toBeGreaterThan(0);
    const normal = await connect();
    expect(await rejects(normal.query('truncate businesses cascade'))).toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED/);
    expect(await rejects(fx.query('truncate businesses cascade'))).toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED/);
    expect({ b: await count(admin, 'businesses'), a: await count(admin, 'partner_credit_accounts') }).toEqual(before);
  });

  it('does not change the row-level guards: the Partner Credit ledger still refuses direct writes outside a disposable activation', async () => {
    const c = await connect();
    expect(await rejects(c.query("insert into partner_credit_ledger(account_id,decision_id,entry_type,units,idempotency_key) values(gen_random_uuid(),gen_random_uuid(),'provisional',1,'k')"))).toMatch(/disabled|guard|inert|violates/i);
    const enabled = await admin.query<{ tgenabled: string }>("select tgenabled::text from pg_trigger where tgname='partner_credit_ledger_insert_disabled'");
    expect(enabled.rows[0]?.tgenabled).toBe('O');
  });

  it('the migration refuses to adopt pre-existing objects: the function and every trigger statement fails when its object already exists, and the whole file leaves nothing behind', async () => {
    const stmts = readFileSync(resolve(api, 'drizzle/0054_split07_08_financial_truncate_denial.sql'), 'utf8').split('--> statement-breakpoint').map(x => x.replace(/^(\s*--.*\n)+/g, '').trim()).filter(Boolean);
    const creates = stmts.filter(x => /^CREATE (FUNCTION|TRIGGER)/.test(x));
    expect(creates).toHaveLength(PROTECTED.length + 1);
    const c = await connect();
    for (const stmt of creates) {
      await c.query('begin');
      const failure = await rejects(c.query(stmt));
      await c.query('rollback');
      expect(failure, stmt.slice(0, 80)).toMatch(/already exists/);
    }
    const left = await admin.query("select count(*)::int n from pg_trigger where tgname like '%\\_no\\_truncate' and tgrelid::regclass::text = any($1)", [[...PROTECTED, ...LEGACY]]);
    expect(left.rows[0]!.n).toBe(PROTECTED.length + LEGACY.length);
  });
});
