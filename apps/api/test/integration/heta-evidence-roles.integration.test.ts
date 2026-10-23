import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * HETA Block G6: the least-privilege role asset (scripts/sql/heta-evidence-least-privilege.sql) applied to a SCRATCH database created and dropped
 * here on the disposable server named by DATABASE_URL. The scratch database is migrated with the repository journal first, so the real 0045/0047
 * objects are what the grants and policies attach to. Nothing touches the main test database, production roles, credentials or Hyperdrive.
 * Requires a superuser connection (SET ROLE to NOLOGIN roles), as the CI service container and a local disposable server provide.
 */
describe.skipIf(!process.env.DATABASE_URL)('HETA G6 least-privilege roles and RLS (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const sqlText = readFileSync(resolve(api, 'scripts/sql/heta-evidence-least-privilege.sql'), 'utf8');
  const db = `echogrid_heta_g6_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const ROLES = ['heta_receipt_writer', 'heta_attestation', 'heta_reconciler', 'heta_tenant_projection', 'heta_forensic_reader'] as const;
  const TABLES = ['stripe_evidence_control_events', 'stripe_evidence_keys', 'stripe_provider_events', 'stripe_provider_malformed_receipts', 'stripe_provider_event_dispositions', 'stripe_provider_event_conflicts'] as const;
  type Priv = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';
  const ALL: Priv[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
  // Expected privileges; anything not listed is DENIED. Mirrors the asset.
  const GRANTS: Record<(typeof ROLES)[number], Partial<Record<(typeof TABLES)[number], Priv[]>>> = {
    heta_receipt_writer: Object.fromEntries(TABLES.map(t => [t, ['SELECT', 'INSERT']])),
    heta_attestation: { stripe_evidence_control_events: ['SELECT', 'INSERT'] },
    heta_reconciler: { stripe_provider_events: ['SELECT', 'INSERT'], stripe_provider_event_dispositions: ['SELECT', 'INSERT'], stripe_provider_event_conflicts: ['SELECT', 'INSERT'], stripe_evidence_control_events: ['SELECT', 'INSERT'], stripe_provider_malformed_receipts: ['SELECT'], stripe_evidence_keys: ['SELECT'] },
    heta_tenant_projection: {},
    heta_forensic_reader: Object.fromEntries(TABLES.map(t => [t, t === 'stripe_evidence_control_events' ? ['SELECT', 'INSERT'] : ['SELECT']])),
  };
  let admin: Client;
  let c: Client;
  const q = async <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await c.query<T>(sql, params)).rows;
  const asRole = async <T>(role: string, fn: () => Promise<T>): Promise<T> => {
    await c.query(`SET ROLE ${role}`);
    try { return await fn(); } finally { await c.query('RESET ROLE'); }
  };
  const denied = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ code: '42501' });
  const insertControl = (kind = 'account_provenance_verified') => c.query(`insert into stripe_evidence_control_events(event_kind,actor,details) values ($1,'g6-test','{"result":"passed"}')`, [kind]);
  const triggerState = async () => JSON.stringify(await q("select tgrelid::regclass::text t, tgname, tgenabled from pg_trigger where not tgisinternal order by 1,2"));
  const constraintState = async () => JSON.stringify(await q("select conrelid::regclass::text t, conname, convalidated from pg_constraint where conrelid::regclass::text in ('partner_credit_lots','partner_credit_ledger','partner_credit_reservations','partner_credit_multiunit_movements') or conname like 'pc_multiunit%' order by 1,2"));

  beforeAll(async () => {
    admin = new Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    await admin.query(`create database ${db}`);
    const m = spawnSync('pnpm', ['exec', 'drizzle-kit', 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(db) } });
    if (m.status !== 0) throw new Error('scratch migrate failed');
    c = new Client({ connectionString: urlFor(db) });
    await c.connect();
  }, 300_000);

  afterAll(async () => {
    if (c) await c.end().catch(() => undefined);
    if (admin) {
      await admin.query(`drop database if exists ${db} with (force)`);
      for (const r of [...ROLES, 'heta_rogue_test']) await admin.query(`drop role if exists ${r}`).catch(() => undefined); // roles are cluster-wide; remove ours
      await admin.end();
    }
  }, 120_000);

  it('applies cleanly, leaves every existing guard, trigger and constraint exactly as it was, and is idempotent', async () => {
    const triggersBefore = await triggerState();
    const constraintsBefore = await constraintState();
    await c.query(sqlText);
    await c.query(sqlText); // second run converges, no error
    expect(await triggerState()).toBe(triggersBefore);
    expect(await constraintState()).toBe(constraintsBefore);
    expect((await q("select count(*)::int n from pg_roles where rolname like 'heta\\_%' and rolname <> 'heta_rogue_test'"))[0]!.n).toBe(5);
    const policies = await q("select count(*)::int n from pg_policies where schemaname='public' and policyname like 'heta\\_%'");
    expect(policies[0]!.n).toBe(Object.values(GRANTS).reduce((n, g) => n + Object.values(g).reduce((m, p) => m + (p?.length ?? 0), 0), 0));
  });

  it('creates only inert NOLOGIN group roles: no login, superuser, role creation, replication, RLS bypass or membership', async () => {
    const rows = await q<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean; rolpassword: unknown }>(
      "select r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolbypassrls, (select passwd from pg_shadow s where s.usename = r.rolname) as rolpassword from pg_roles r where r.rolname = any($1)", [ROLES]);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false });
    for (const r of rows) expect(r.rolpassword ?? null).toBeNull();
    expect((await q("select count(*)::int n from pg_auth_members m join pg_roles r on r.oid in (m.roleid, m.member) where r.rolname = any($1)", [ROLES]))[0]!.n).toBe(0);
  });

  it('the privilege matrix is exactly the documented least privilege: nobody gets UPDATE, DELETE or TRUNCATE, PUBLIC gets nothing', async () => {
    for (const role of ROLES) for (const t of TABLES) for (const p of ALL) {
      const has = (await q<{ h: boolean }>('select has_table_privilege($1,$2,$3) h', [role, `public.${t}`, p]))[0]!.h;
      const want = (GRANTS[role][t] ?? []).includes(p);
      expect({ role, t, p, has }).toEqual({ role, t, p, has: want });
    }
    for (const t of TABLES) {
      expect((await q("select count(*)::int n from information_schema.role_table_grants where table_name=$1 and grantee='PUBLIC'", [t]))[0]!.n).toBe(0);
    }
  });

  it('row-level security is enabled (not forced) on all six tables', async () => {
    const rows = await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>("select relname, relrowsecurity, relforcerowsecurity from pg_class where relname = any($1) order by 1", [TABLES]);
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r).toMatchObject({ relrowsecurity: true, relforcerowsecurity: false });
  });

  it('roles act within their grants and are refused outside them (real statements under SET ROLE)', async () => {
    await insertControl(); // as owner, so a row exists
    await asRole('heta_receipt_writer', async () => {
      expect((await q('select count(*)::int n from stripe_evidence_control_events'))[0]!.n).toBeGreaterThanOrEqual(1);
      await insertControl('account_provenance_verified');
      await denied(c.query("update stripe_evidence_control_events set actor='x'"));
      await denied(c.query('delete from stripe_evidence_control_events'));
      await denied(c.query('truncate stripe_evidence_control_events'));
    });
    await asRole('heta_attestation', async () => {
      await insertControl();
      await denied(c.query('select 1 from stripe_provider_events limit 1'));
      await denied(c.query('select 1 from stripe_evidence_keys limit 1'));
    });
    await asRole('heta_reconciler', async () => {
      await q('select 1 from stripe_provider_events limit 1');
      await denied(c.query('select 1 from stripe_evidence_control_events').then(() => c.query('insert into stripe_evidence_keys(cohort,kek_version,wrapped_dek,wrap_nonce,wrap_algorithm,dek_fingerprint) values (\'2099-01\',\'v\',\'\\x00\',\'\\x00\',\'a\',\'\\x00\')')));
    });
    await asRole('heta_forensic_reader', async () => {
      await q('select 1 from stripe_provider_events limit 1');
      await denied(c.query('insert into stripe_provider_event_conflicts default values'));
      await insertControl(); // its reads are audited by inserting a control event
    });
    await asRole('heta_tenant_projection', async () => {
      for (const t of TABLES) await denied(c.query(`select 1 from ${t} limit 1`));
      await denied(insertControl());
    });
  });

  it('RLS is defense in depth: a role given a broad GRANT by mistake still sees no rows and inserts none', async () => {
    await c.query('create role heta_rogue_test nologin');
    await c.query('grant select, insert on stripe_evidence_control_events to heta_rogue_test');
    const owned = (await q<{ n: number }>('select count(*)::int n from stripe_evidence_control_events'))[0]!.n;
    expect(owned).toBeGreaterThan(0);
    await asRole('heta_rogue_test', async () => {
      expect((await q('select count(*)::int n from stripe_evidence_control_events'))[0]!.n).toBe(0);
      await denied(insertControl());
    });
    await c.query('revoke all on stripe_evidence_control_events from heta_rogue_test');
  });

  it('the append-only triggers still refuse mutation of existing evidence, for the owner too', async () => {
    await expect(c.query("update stripe_evidence_control_events set actor='tamper'")).rejects.toBeDefined();
    await expect(c.query('delete from stripe_evidence_control_events')).rejects.toBeDefined();
    await expect(c.query('truncate stripe_evidence_control_events')).rejects.toBeDefined();
  });

  it('re-applying converges: a privilege added by drift is revoked again', async () => {
    await c.query('grant select on stripe_provider_events to heta_tenant_projection');
    expect((await q<{ h: boolean }>("select has_table_privilege('heta_tenant_projection','public.stripe_provider_events','SELECT') h"))[0]!.h).toBe(true);
    await c.query(sqlText);
    expect((await q<{ h: boolean }>("select has_table_privilege('heta_tenant_projection','public.stripe_provider_events','SELECT') h"))[0]!.h).toBe(false);
  });
});
