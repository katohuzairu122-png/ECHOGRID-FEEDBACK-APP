import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Migration 0055: a replica-role TRUNCATE of the two 0052 allocation tables is denied by a separate ENABLE ALWAYS truncate-only trigger, while the 0052 triggers (which
 * also guard INSERT/UPDATE/DELETE and are deliberately still ENABLE ORIGIN so replica-role fixtures keep working) are unchanged. Scratch database only; no Stripe, Neon or
 * production resource.
 */
const TABLES = { s08_allocation_freezes: 's08_allocation_parent_truncate_always', s08_allocation_freeze_items: 's08_allocation_child_truncate_always' } as const;
const OLD = { s08_allocation_freezes: 's08_allocation_parent_deny', s08_allocation_freeze_items: 's08_allocation_child_deny' } as const;

describe.skipIf(!process.env.DATABASE_URL)('S08 allocation tables: replica-role TRUNCATE denial (0055, integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_alloc_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const clients: Client[] = [];
  let admin: Client;
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const rejects = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return String((e as Error)?.message ?? e); } };

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

  it('each allocation table has a truncate-only, statement-level, BEFORE, ENABLE ALWAYS trigger on the 0054 function', async () => {
    for (const [table, name] of Object.entries(TABLES)) {
      const r = await admin.query<{ enabled: string; type: number; fn: string }>(
        `select t.tgenabled::text enabled, t.tgtype::int type, p.proname fn from pg_trigger t join pg_proc p on p.oid = t.tgfoid where t.tgrelid = $1::regclass and t.tgname = $2 and not t.tgisinternal`, [table, name]);
      expect(r.rows, table).toHaveLength(1);
      expect(r.rows[0]!.enabled, table).toBe('A');
      expect(r.rows[0]!.type & 61, `${table} truncate-only, statement, not row/insert/update/delete`).toBe(32);
      expect(r.rows[0]!.type & 2, `${table} BEFORE`).toBe(2);
      expect(r.rows[0]!.fn).toBe('financial_evidence_deny_truncate');
    }
  });

  it('a replica-role TRUNCATE (plain, CASCADE, RESTART IDENTITY, both tables at once) is denied by the new trigger and removes nothing', async () => {
    const replica = await connect();
    await replica.query('SET session_replication_role = replica');
    for (const table of Object.keys(TABLES))
      for (const sql of [`truncate ${table}`, `truncate ${table} cascade`, `truncate ${table} restart identity cascade`])
        expect(await rejects(replica.query(sql)), sql).toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED|cannot truncate a table referenced/);
    expect(await rejects(replica.query(`truncate ${Object.keys(TABLES).join(',')}`)), 'both tables').toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED/);
    expect(await rejects(replica.query('truncate s08_allocation_freezes cascade')), 'cascade').toMatch(/FINANCIAL_EVIDENCE_TRUNCATE_DENIED/);
  });

  for (const [table, name] of Object.entries(TABLES)) {
    it(`${table}: the new trigger denies a replica-role TRUNCATE on its own (every other truncate trigger disabled)`, async () => {
      const c = await connect();
      await c.query('begin');
      try {
        await c.query('SET LOCAL session_replication_role = replica');
        const others = await c.query<{ t: string; n: string }>(`select tgrelid::regclass::text t, tgname n from pg_trigger where not tgisinternal and (tgtype & 32) = 32 and tgname <> $1`, [name]);
        for (const o of others.rows) await c.query(`alter table ${o.t} disable trigger ${o.n}`);
        expect(await rejects(c.query(`truncate ${table} cascade`))).toMatch(new RegExp(`FINANCIAL_EVIDENCE_TRUNCATE_DENIED \\(${table}\\)`));
      } finally { await c.query('rollback'); await c.end(); }
    });
  }

  it('a normal-session TRUNCATE still raises the existing S08_ALLOCATION_INERT first (the new triggers sort after the 0052 ones)', async () => {
    const c = await connect();
    for (const table of Object.keys(TABLES)) expect(await rejects(c.query(`truncate ${table} cascade`)), table).toMatch(/S08_ALLOCATION_INERT/);
  });

  it('the 0052 triggers are unchanged: same definition, still ENABLE ORIGIN (replica-role fixtures keep working)', async () => {
    for (const [table, name] of Object.entries(OLD)) {
      const r = await admin.query<{ enabled: string; def: string }>(`select tgenabled::text enabled, pg_get_triggerdef(oid) def from pg_trigger where tgrelid = $1::regclass and tgname = $2`, [table, name]);
      expect(r.rows, table).toHaveLength(1);
      expect(r.rows[0]!.enabled, table).toBe('O');
      expect(r.rows[0]!.def, table).toMatch(/BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public\.s08_allocation_/);
    }
  });

  it('every table that has a truncate trigger now also has an ENABLE ALWAYS one (the 0054 exception is closed)', async () => {
    const r = await admin.query<{ t: string }>(
      `select distinct x.tgrelid::regclass::text t from pg_trigger x where not x.tgisinternal and (x.tgtype & 32) = 32
        and not exists (select 1 from pg_trigger y where y.tgrelid = x.tgrelid and not y.tgisinternal and (y.tgtype & 32) = 32 and y.tgenabled = 'A')`);
    expect(r.rows.map(x => x.t)).toEqual([]);
  });

  it('the migration refuses to adopt pre-existing triggers, statement by statement', async () => {
    const stmts = readFileSync(resolve(api, 'drizzle/0055_s08_allocation_truncate_always.sql'), 'utf8').split('--> statement-breakpoint').map(x => x.replace(/^(\s*--.*\n)+/g, '').trim()).filter(Boolean);
    const creates = stmts.filter(x => /^CREATE TRIGGER/.test(x));
    expect(creates).toHaveLength(2);
    const c = await connect();
    for (const stmt of creates) {
      await c.query('begin');
      const failure = await rejects(c.query(stmt));
      await c.query('rollback');
      expect(failure, stmt.slice(0, 70)).toMatch(/already exists/);
    }
  });
});
