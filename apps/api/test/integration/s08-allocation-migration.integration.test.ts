import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { buildDb } from '../../src/db/client';
import { BenefitApplicationSagaService } from '../../src/billing/benefit-application.saga.service';

/** Disposable-only install/upgrade and actual restricted-role evidence.
 * Privileged synthetic parents never represent an eligible award or invoice. */
describe.skipIf(!process.env.DATABASE_URL)('S08 0052 inert allocation migration', () => {
  const token = randomBytes(5).toString('hex');
  const prefix = `echogrid_s08_migration_${token}`;
  const role = `s08_reader_${token}`;
  const folder = resolve(__dirname, '../../drizzle');
  const journal = JSON.parse(readFileSync(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  // The migration under test is 0052 itself, not whatever happens to be last in the journal: later migrations (0053+) must not change what this suite proves.
  const last = journal.entries.find((e) => e.tag === '0052_s08_inert_allocation_freezes')!;
  const tables = ['s08_allocation_freezes', 's08_allocation_freeze_items'];
  const guards = [
    'partner_credit_ledger_insert_disabled',
    'partner_credit_lots_inert_guard',
    'partner_credit_reservations_inert_guard',
    'pc_multiunit_allocation_inert_guard',
    'pc_multiunit_movement_inert_guard',
  ];
  let admin: Client;
  let template: string;
  let baseline: string;
  const databases: string[] = [];
  const clients: Client[] = [];
  const folders: string[] = [];
  let freshCatalog: unknown;
  const url = (db: string) => {
    const u = new URL(process.env.DATABASE_URL!);
    u.pathname = '/' + db;
    return u.toString();
  };
  const connect = async (db: string) => {
    const c = new Client({ connectionString: url(db) });
    await c.connect();
    clients.push(c);
    return c;
  };
  const copy = (includeLast: boolean, fail = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'echogrid-s08-migrations-'));
    folders.push(dir);
    mkdirSync(join(dir, 'meta'));
    const entries = journal.entries.filter((e) => (includeLast ? e.idx <= last.idx : e.idx < last.idx));
    writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const e of entries)
      writeFileSync(join(dir, e.tag + '.sql'), readFileSync(join(folder, e.tag + '.sql')));
    if (fail) {
      const file = join(dir, last.tag + '.sql');
      writeFileSync(
        file,
        readFileSync(file, 'utf8') +
          "\n--> statement-breakpoint\nDO $$ BEGIN RAISE EXCEPTION 'S08_TEST_MIGRATION_FAILURE'; END $$;\n",
      );
    }
    return dir;
  };
  const database = async (fromTemplate = true) => {
    const name = `${prefix}_${databases.length}`;
    await admin.query(`CREATE DATABASE ${name}${fromTemplate ? ` TEMPLATE ${template}` : ''}`);
    databases.push(name);
    return connect(name);
  };
  const upgrade = (c: Client, path = folder) => migrate(buildDb(c), { migrationsFolder: path });
  const guardState = async (c: Client) =>
    (
      await c.query(
        'SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname',
        [guards],
      )
    ).rows;
  const assertGuards = async (c: Client) =>
    expect(await guardState(c)).toEqual(
      [...guards].sort().map((tgname) => ({ tgname, tgenabled: 'O' })),
    );
  const catalog = async (c: Client) => ({
    constraints: (
      await c.query(
        `SELECT c.relname, pg_get_constraintdef(k.oid) definition
      FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
      WHERE c.relname=ANY($1::text[]) ORDER BY c.relname,definition`,
        [tables],
      )
    ).rows,
    columns: (
      await c.query(
        `SELECT table_name,column_name,data_type,is_nullable,column_default
      FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])
      ORDER BY table_name,ordinal_position`,
        [tables],
      )
    ).rows,
    indexes: (
      await c.query(
        `SELECT tablename,indexname,indexdef FROM pg_indexes
      WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename,indexname`,
        [tables],
      )
    ).rows,
    triggers: (
      await c.query(
        `SELECT c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relname=ANY($1::text[]) AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`,
        [tables],
      )
    ).rows,
  });
  const hashes = async (c: Client) => {
    const records = (
      await c.query<{ hash: string }>('SELECT hash FROM drizzle.__drizzle_migrations ORDER BY id')
    ).rows;
    expect(records.map((r) => r.hash)).toEqual(
      journal.entries.map((e) =>
        createHash('sha256')
          .update(readFileSync(join(folder, e.tag + '.sql'), 'utf8'))
          .digest('hex'),
      ),
    );
  };
  const seed = async (c: Client) => {
    const business = randomUUID(),
      reservation = randomUUID(),
      intent = randomUUID();
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role=replica');
    await c.query(
      "INSERT INTO businesses(id,name,slug,status) VALUES($1::uuid,'Synthetic upgrade fixture',$1::text,'active')",
      [business],
    );
    // the saga refuses a reservation whose settlement is not fulfilled (R10 review MEDIUM-1): forge the fulfilled settlement and decision it stands on
    const claim = (
      await c.query<{ id: string }>(
        `INSERT INTO orphan_reward_claims(customer_id,origin_business_id,origin_loyalty_account_id,origin_loyalty_transaction_id,orphan_reason,source_reward_type,source_reward_snapshot,status,settled_at)
         VALUES (gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'origin_business_archived','voucher','{}'::jsonb,'settled',now()) RETURNING id`,
      )
    ).rows[0]!.id;
    const settlement = (
      await c.query<{ id: string }>(
        `INSERT INTO orphan_settlements(claim_id,customer_id,receiving_business_id,status,access_authorization_id,accepted_by_user_id,accepted_at,completion_authorization_id,completion_authorized_at,
           fulfilled_by_user_id,fulfilled_at,fulfillment_policy_version,fulfillment_snapshot,expires_at,idempotency_key)
         VALUES ($1,gen_random_uuid(),$2,'fulfilled',gen_random_uuid(),gen_random_uuid(),now(),gen_random_uuid(),now(),gen_random_uuid(),now(),'v1','{}'::jsonb,now()+interval '30 days',$3) RETURNING id`,
        [claim, business, `legacy_settle_${reservation}`],
      )
    ).rows[0]!.id;
    const decision = (
      await c.query<{ id: string }>(
        `INSERT INTO partner_credit_award_decisions(settlement_ref,business_id,policy_id,state,award_units,earning_month_utc,fulfilled_at,vest_at,idempotency_key)
         VALUES ($1,$2,gen_random_uuid(),'vested',1,'2026-10',now(),now(),$3) RETURNING id`,
        [settlement, business, `legacy_dec_${reservation}`],
      )
    ).rows[0]!.id;
    await c.query(
      `INSERT INTO partner_credit_reservations(id,business_id,decision_id,lot_id,account_id,invoice_intent_ref,idempotency_key,expires_at)
      VALUES($1::uuid,$2,$3,gen_random_uuid(),gen_random_uuid(),'legacy_intent',$1::text,clock_timestamp()+interval '1 day')`,
      [reservation, business, decision],
    );
    await c.query(
      `INSERT INTO benefit_application_intents(id,business_id,reservation_id,invoice_ref,expected_benefit_minor,currency,policy_version)
      VALUES($1,$2,$3,'in_legacy',300,'usd','PC-BENEFIT/1')`,
      [intent, business, reservation],
    );
    await c.query('COMMIT');
    return { business, reservation, intent };
  };
  const parent = (c: Client, business: string, overrides: Record<string, unknown> = {}) => {
    const values = {
      business_id: business,
      invoice_ref: randomUUID(),
      currency: 'usd',
      policy_version: 'S08-AGG-ROUND/1',
      allocation_digest: 'a'.repeat(64),
      aggregate_benefit_minor: '3',
      reservation_count: 1,
      artifact: '{}',
      ...overrides,
    };
    const keys = Object.keys(values);
    return c.query<{ id: string }>(
      `INSERT INTO s08_allocation_freezes(${keys.join(',')}) VALUES(${keys.map((_, i) => '$' + (i + 1)).join(',')}) RETURNING id`,
      Object.values(values),
    );
  };

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL!);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      !/^echogrid_(test|ci_|scratch_)/.test(target.pathname.slice(1))
    )
      throw new Error('Requires local disposable PostgreSQL');
    expect(last.tag).toBe('0052_s08_inert_allocation_freezes');
    admin = await connect('postgres');
    template = `${prefix}_template`;
    databases.push(template);
    await admin.query(`CREATE DATABASE ${template}`);
    const c = await connect(template);
    baseline = copy(false);
    await upgrade(c, baseline);
    await c.end();
    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT`,
    );
  }, 120_000);
  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const c = new Client({ connectionString: url('postgres') });
    await c.connect();
    try {
      for (const name of databases.reverse())
        await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${role}`);
    } finally {
      await c.end();
      for (const dir of folders) rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('replays all 53 migrations from empty with exact SQL hashes and all economic guards', async () => {
    const c = await database(false);
    await upgrade(c);
    await hashes(c);
    await assertGuards(c);
    const installed = await catalog(c);
    freshCatalog = installed;
    expect(installed.constraints.length).toBeGreaterThan(12);
    // the two 0052 statement triggers (ENABLE ORIGIN) and, from 0055, one truncate-only ENABLE ALWAYS sibling for each table
    expect(installed.triggers.map((t) => `${t.tgname}:${t.tgenabled}`)).toEqual([
      's08_allocation_child_deny:O',
      's08_allocation_child_truncate_always:A',
      's08_allocation_parent_deny:O',
      's08_allocation_parent_truncate_always:A',
    ]);
  });
  it('upgrades populated 0051 without changing legacy rows; schema equals fresh replay; rerun is inert', async () => {
    const c = await database();
    const fixture = await seed(c);
    const before = (
      await c.query('SELECT * FROM benefit_application_intents WHERE id=$1', [fixture.intent])
    ).rows;
    await upgrade(c);
    await upgrade(c);
    await hashes(c);
    await assertGuards(c);
    expect(await catalog(c)).toEqual(freshCatalog);
    expect(
      (await c.query('SELECT * FROM benefit_application_intents WHERE id=$1', [fixture.intent]))
        .rows,
    ).toEqual(before);
    expect((await c.query('SELECT count(*)::int n FROM s08_allocation_freezes')).rows[0]!.n).toBe(
      0,
    );
  });
  it.each(['parent', 'child', 'both', 'function', 'candidate'])(
    'rejects pre-existing %s atomically without adoption or journal entry',
    async (shape) => {
      const c = await database();
      if (shape === 'parent' || shape === 'both')
        await c.query('CREATE TABLE s08_allocation_freezes(sentinel text)');
      if (shape === 'child' || shape === 'both')
        await c.query('CREATE TABLE s08_allocation_freeze_items(sentinel text)');
      if (shape === 'function')
        await c.query(
          'CREATE FUNCTION s08_allocation_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
        );
      if (shape === 'candidate')
        await c.query(
          readFileSync(
            resolve(__dirname, '../../scripts/sql/s08-allocation-freeze.candidate.sql'),
            'utf8',
          ),
        );
      const before = await catalog(c);
      await expect(upgrade(c)).rejects.toThrow();
      expect(
        (await c.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0]!.n,
      ).toBe(52);
      expect(await catalog(c)).toEqual(before);
      await assertGuards(c);
      expect(
        (
          await c.query(
            "SELECT to_regclass('public.s08_allocation_freezes') IS NOT NULL p,to_regclass('public.s08_allocation_freeze_items') IS NOT NULL c",
          )
        ).rows[0],
      ).toEqual({
        p: shape === 'parent' || shape === 'both' || shape === 'candidate',
        c: shape === 'child' || shape === 'both' || shape === 'candidate',
      });
    },
  );
  it('rolls back an injected failure after table/guard creation and retries the original migration', async () => {
    const c = await database();
    await expect(upgrade(c, copy(true, true))).rejects.toThrow();
    expect(
      (
        await c.query(
          "SELECT to_regclass('s08_allocation_freezes') p,to_regclass('s08_allocation_freeze_items') c,to_regprocedure('s08_allocation_deny_mutation()') f",
        )
      ).rows[0],
    ).toEqual({ p: null, c: null, f: null });
    expect(
      (await c.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0]!.n,
    ).toBe(52);
    await upgrade(c);
    await hashes(c);
    await assertGuards(c);
  });
  it.each(
    tables.flatMap((table) =>
      ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map((operation) => ({ table, operation })),
    ),
  )('denies $operation on migrated $table even to its owner', async ({ table, operation }) => {
    const c = await database();
    await upgrade(c);
    const query =
      operation === 'INSERT'
        ? `INSERT INTO ${table} DEFAULT VALUES`
        : operation === 'UPDATE'
          ? `UPDATE ${table} SET business_id=business_id`
          : `${operation}${operation === 'DELETE' ? ' FROM' : ''} ${operation === 'TRUNCATE' && table === tables[0] ? tables.join(',') : table}`;
    await expect(c.query(query)).rejects.toThrow('S08_ALLOCATION_INERT');
    await assertGuards(c);
  });
  it('uses a restricted role: no implicit writes or ownership; accidental DML grants still hit guards', async () => {
    const c = await database();
    await upgrade(c);
    await c.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await c.query(`GRANT SELECT ON ${tables.join(',')} TO ${role}`);
    await c.query(`SET ROLE ${role}`);
    expect((await c.query('SELECT count(*)::int n FROM s08_allocation_freezes')).rows[0]!.n).toBe(
      0,
    );
    await expect(
      c.query('INSERT INTO s08_allocation_freezes DEFAULT VALUES'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      c.query('ALTER TABLE s08_allocation_freezes DISABLE TRIGGER ALL'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(c.query('SET session_replication_role=replica')).rejects.toMatchObject({
      code: '42501',
    });
    await c.query('RESET ROLE');
    await c.query(`GRANT INSERT,UPDATE,DELETE,TRUNCATE ON ${tables.join(',')} TO ${role}`);
    await c.query(`SET ROLE ${role}`);
    for (const table of tables)
      for (const query of [
        `INSERT INTO ${table} DEFAULT VALUES`,
        `UPDATE ${table} SET business_id=business_id`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table === tables[0] ? tables.join(',') : table}`,
      ])
        await expect(c.query(query)).rejects.toThrow('S08_ALLOCATION_INERT');
    await c.query('RESET ROLE');
    await assertGuards(c);
  });
  it.each([
    { currency: 'USD' },
    { policy_version: 'unknown' },
    { allocation_digest: 'bad' },
    { aggregate_benefit_minor: '0' },
    { reservation_count: 11 },
    { artifact: '[]' },
    { provider_verified: true },
    { consumption_authorized: true },
  ])(
    'retains SQL shape/false-authority checks for %j beneath the inert guard',
    async (overrides) => {
      const c = await database();
      await upgrade(c);
      const fixture = await seed(c);
      await c.query(
        'ALTER TABLE s08_allocation_freezes DISABLE TRIGGER s08_allocation_parent_deny',
      );
      try {
        await expect(parent(c, fixture.business, overrides)).rejects.toMatchObject({
          code: '23514',
        });
      } finally {
        await c.query(
          'ALTER TABLE s08_allocation_freezes ENABLE TRIGGER s08_allocation_parent_deny',
        );
      }
      await assertGuards(c);
    },
  );
  it('retains tenant FKs, reservation/provider-key uniqueness and lossless bigint storage', async () => {
    const c = await database();
    await upgrade(c);
    const a = await seed(c),
      b = await seed(c);
    for (const [i, t] of tables.entries())
      await c.query(
        `ALTER TABLE ${t} DISABLE TRIGGER s08_allocation_${i === 0 ? 'parent' : 'child'}_deny`,
      );
    try {
      const p = (await parent(c, a.business, { aggregate_benefit_minor: '9007199254740993' }))
        .rows[0]!.id;
      expect(
        (
          await c.query('SELECT aggregate_benefit_minor FROM s08_allocation_freezes WHERE id=$1', [
            p,
          ])
        ).rows[0]!.aggregate_benefit_minor,
      ).toBe('9007199254740993');
      const insert = (
        freeze = p,
        business = a.business,
        reservation = a.reservation,
        key = 'one',
      ) =>
        c.query(`INSERT INTO s08_allocation_freeze_items VALUES($1,$2,$3,'legacy_intent',1,$4)`, [
          freeze,
          business,
          reservation,
          key,
        ]);
      await expect(insert(p, a.business, b.reservation)).rejects.toMatchObject({ code: '23503' });
      await expect(insert(p, b.business, b.reservation)).rejects.toMatchObject({ code: '23503' });
      await insert();
      // The child FK is ON DELETE RESTRICT. PostgreSQL 16/17 reports 23503 (foreign_key_violation); PostgreSQL 18 reports 23001 (restrict_violation) for the same
      // refusal. Either code is the restriction doing its job; the insert-side FK checks above stay strictly 23503 on every version.
      const restricted = await c.query('DELETE FROM s08_allocation_freezes WHERE id=$1', [p]).then(
        () => undefined,
        (e: { code?: string }) => e,
      );
      expect(['23503', '23001']).toContain(restricted?.code);
      await expect(
        c.query(
          "INSERT INTO s08_allocation_freeze_items VALUES($1,$2,$3,'legacy_intent',0,'zero')",
          [p, b.business, b.reservation],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      const p2 = (await parent(c, a.business)).rows[0]!.id;
      await expect(insert(p2, a.business, a.reservation, 'two')).rejects.toMatchObject({
        code: '23505',
      });
      const p3 = (await parent(c, b.business)).rows[0]!.id;
      await expect(insert(p3, b.business, b.reservation, 'one')).rejects.toMatchObject({
        code: '23505',
      });
    } finally {
      for (const [i, t] of tables.entries())
        await c.query(
          `ALTER TABLE ${t} ENABLE TRIGGER s08_allocation_${i === 0 ? 'parent' : 'child'}_deny`,
        );
    }
    await assertGuards(c);
  });
  it('denies an unfrozen legacy new attempt after upgrade but preserves an existing attempt replay', async () => {
    const c = await database();
    const a = await seed(c),
      b = await seed(c);
    // The old-schema positive fixture has no provider or economic side effects.
    for (const t of [
      'benefit_application_intents',
      'benefit_provider_attempts',
      'benefit_application_transitions',
    ])
      await c.query(`ALTER TABLE ${t} DISABLE TRIGGER ${t}_inert_guard`);
    const saga = new BenefitApplicationSagaService(buildDb(c));
    expect(await saga.beginApply(a.intent, 'original')).toMatchObject({ ok: true, replay: false });
    await upgrade(c);
    expect(await saga.beginApply(b.intent, 'new')).toMatchObject({
      ok: false,
      code: 'ALLOCATION_REQUIRED',
    });
    expect(await saga.beginApply(a.intent, 'original')).toMatchObject({ ok: true, replay: true });
    expect(await saga.beginApply(a.intent, 'replacement')).toMatchObject({
      ok: false,
      code: 'ATTEMPT_CONFLICT',
    });
    expect(
      (await c.query('SELECT count(*)::int n FROM benefit_provider_attempts')).rows[0]!.n,
    ).toBe(1);
    await assertGuards(c);
  });
});
