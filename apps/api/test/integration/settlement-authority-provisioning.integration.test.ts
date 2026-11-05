import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * D1/D3-DEV-05. Migration 0061 as a NON-SUPERUSER owner (the realistic migrator), and the provisioning template. Scratch databases and synthetic roles only; the roles are removed afterwards.
 * The migrator here may create roles (CREATEROLE) and is granted ADMIN OPTION on the settlement roles, which is exactly what PostgreSQL gives a role that created them itself.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-05 settlement authority: non-superuser migration and provisioning (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const suffix = randomBytes(4).toString('hex');
  const dbName = `echogrid_s08_dev05_${suffix}`;
  const migrator = `dev05_migrator_${suffix}`;
  const appLogin = `dev05_app_${suffix}`;
  const recorderLogin = `dev05_rec_${suffix}`;
  const password = randomBytes(12).toString('hex'); // synthetic, per run
  const urlFor = (name: string, user?: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; if (user) { u.username = user; u.password = password; } return u.toString(); };
  const SETTLEMENT_ROLES = ['settlement_recorder', 'settlement_consumer', 'settlement_authority_reader', 'settlement_tenant_reader', 'settlement_auditor'];
  /** DEV-10 (migration 0062) group roles; the migrator is given the same ADMIN OPTION when another database already created them. */
  const READ_AUTH_ROLES = ['stripe_read_auth_lifecycle', 'stripe_read_auth_admin', 'stripe_read_auth_verifier', 'stripe_read_auth_tenant_reader', 'stripe_read_auth_auditor'];
  const clients: Client[] = [];
  let root: Client;
  let owner: Client;
  const errText = (e: unknown) => String((e as Error)?.message ?? e);
  const tryQ = async (c: Client, text: string) => { try { return { error: '', rows: (await c.query(text)).rows as Array<Record<string, unknown>> }; } catch (e) { return { error: errText(e), rows: [] as Array<Record<string, unknown>> }; } };
  const script = (a: string, r: string) => readFileSync(resolve(api, 'scripts/sql/settlement-authority-provisioning.sql'), 'utf8')
    .replace('REPLACE_WITH_APPLICATION_LOGIN', a).replace('REPLACE_WITH_RECORDER_LOGIN', r);

  beforeAll(async () => {
    root = new Client({ connectionString: urlFor('postgres') }); await root.connect();
    await root.query(`create role ${migrator} login createrole password '${password}'`);
    for (const l of [appLogin, recorderLogin]) await root.query(`create role ${l} login password '${password}'`);
    // the group roles may already exist (created by another database's migration, by a superuser): the migrator is then given ADMIN OPTION, which is what creating them itself would have given it
    for (const r of [...SETTLEMENT_ROLES, ...READ_AUTH_ROLES]) {
      if ((await root.query('select 1 from pg_roles where rolname=$1', [r])).rowCount) await root.query(`grant ${r} to ${migrator} with admin option, inherit false, set false`);
    }
    await root.query(`create database ${dbName} owner ${migrator}`);
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName, migrator) } });
    if (m.status !== 0) throw new Error(`non-superuser migrate failed: ${(m.stdout + m.stderr).slice(-400)}`);
    owner = new Client({ connectionString: urlFor(dbName, migrator) }); await owner.connect(); clients.push(owner);
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) { try { await c.end(); } catch { /* closed */ } }
    try { await root.query(`drop database if exists ${dbName} with (force)`); } catch { /* ignore */ }
    for (const r of [migrator, appLogin, recorderLogin]) { try { await root.query(`drop role if exists ${r}`); } catch { /* shared cluster */ } }
    await root.end();
  });

  it('M1. migration 0061 applies for a non-superuser owner, and leaves no temporary grant behind', async () => {
    expect((await root.query('select rolsuper from pg_roles where rolname=$1', [migrator])).rows).toEqual([{ rolsuper: false }]);
    const db = new Client({ connectionString: urlFor(dbName) }); await db.connect(); clients.push(db);
    expect((await db.query("select count(*)::int n from drizzle.__drizzle_migrations")).rows[0].n).toBeGreaterThanOrEqual(62);
    // the owner owns the table; the definer functions belong to the narrow internal role; RLS is on and forced
    expect((await db.query("select pg_get_userbyid(relowner) o, relrowsecurity r, relforcerowsecurity f from pg_class where relname='partner_credit_settlement_authorizations'")).rows).toEqual([{ o: migrator, r: true, f: true }]);
    expect((await db.query("select proname, pg_get_userbyid(proowner) o, prosecdef d from pg_proc where proname in ('partner_credit_settlement_auth_read','partner_credit_ledger_settlement_gate') order by 1")).rows)
      .toEqual([{ proname: 'partner_credit_ledger_settlement_gate', o: 'settlement_authority_reader', d: true }, { proname: 'partner_credit_settlement_auth_read', o: 'settlement_authority_reader', d: true }]);
    // the temporary schema CREATE and SET membership were revoked again: the internal role cannot create objects, and the migrator cannot assume it
    expect((await db.query("select has_schema_privilege('settlement_authority_reader','public','CREATE') c")).rows[0].c).toBe(false);
    expect((await db.query("select pg_has_role($1,'settlement_authority_reader','SET') s", [migrator])).rows[0].s).toBe(false);
    expect((await db.query("select pg_has_role($1,'settlement_authority_reader','USAGE') u", [migrator])).rows[0].u).toBe(false);
    expect((await tryQ(owner, 'SET ROLE settlement_authority_reader')).error).toMatch(/permission denied to set role|must be able to SET ROLE/);
    // the roles are safe
    expect((await db.query("select count(*)::int n from pg_roles where rolname = any($1) and (rolsuper or rolbypassrls or rolcanlogin or rolcreaterole)", [SETTLEMENT_ROLES])).rows[0].n).toBe(0);
  });

  it('M1b. migration 0062 (DEV-10) applies for a non-superuser owner too: definer functions belong to the narrow lifecycle role, its temporary schema CREATE and SET membership are gone, and the roles are safe', async () => {
    const db = new Client({ connectionString: urlFor(dbName) }); await db.connect(); clients.push(db);
    expect((await db.query("select pg_get_userbyid(relowner) o, relrowsecurity r, relforcerowsecurity f from pg_class where relname='stripe_read_authorizations'")).rows).toEqual([{ o: migrator, r: true, f: true }]);
    const fns = (await db.query("select proname, pg_get_userbyid(proowner) o from pg_proc where prosecdef and proname like 'stripe_read_auth_%' order by 1")).rows;
    expect(fns.length).toBe(7); expect(fns.every(f => f.o === 'stripe_read_auth_lifecycle')).toBe(true);
    expect((await db.query("select has_schema_privilege('stripe_read_auth_lifecycle','public','CREATE') c")).rows[0].c).toBe(false);
    expect((await db.query("select pg_has_role($1,'stripe_read_auth_lifecycle','SET') s", [migrator])).rows[0].s).toBe(false);
    expect((await tryQ(owner, 'SET ROLE stripe_read_auth_lifecycle')).error).toMatch(/permission denied to set role|must be able to SET ROLE/);
    expect((await db.query("select count(*)::int n from pg_roles where rolname = any($1) and (rolsuper or rolbypassrls or rolcanlogin or rolcreaterole)", [READ_AUTH_ROLES])).rows[0].n).toBe(0);
    // approval is disabled in the migrated database, and the table owner is still bound by forced RLS (it reads nothing)
    expect((await db.query('select approval_enabled from stripe_read_authorization_policy')).rows).toEqual([{ approval_enabled: false }]);
    expect((await tryQ(owner, 'select count(*)::int n from stripe_read_authorizations')).rows).toEqual([{ n: 0 }]);
  });

  it('M1c. migration 0063 (DEV-11-R1) applies for a non-superuser owner: an additive, nullable session_id column and its index, with no existing row rewritten', async () => {
    const db = new Client({ connectionString: urlFor(dbName) }); await db.connect(); clients.push(db);
    expect((await db.query("select data_type, is_nullable, column_default from information_schema.columns where table_name='refresh_tokens' and column_name='session_id'")).rows).toEqual([{ data_type: 'uuid', is_nullable: 'YES', column_default: null }]);
    expect((await db.query("select indexdef from pg_indexes where indexname='refresh_tokens_session_idx'")).rows[0].indexdef).toMatch(/\(user_id, session_id\)/);
    // rows that existed before the column (legacy sessions) keep a NULL session id: the column has no default and the migration has no data statement
    const u = (await db.query("select id from users limit 1")).rows[0]; void u;
    expect((await db.query("select count(*)::int n from refresh_tokens where session_id is not null")).rows[0].n).toBe(0);
  });

  it('M2. the owner of the table is still bound by forced RLS: it reads nothing and cannot insert evidence', async () => {
    expect((await tryQ(owner, 'select count(*)::int n from partner_credit_settlement_authorizations')).rows).toEqual([{ n: 0 }]);
    expect((await tryQ(owner, 'insert into partner_credit_settlement_authorizations(id) values (gen_random_uuid())')).error).toMatch(/row-level security|SETTLEMENT_AUTH|violates/);
    expect((await tryQ(owner, 'alter table partner_credit_settlement_authorizations disable trigger partner_credit_settlement_authorizations_no_update_delete')).error).toBe(''); // the owner CAN do this (documented residual risk) ...
    expect((await tryQ(owner, 'alter table partner_credit_settlement_authorizations enable always trigger partner_credit_settlement_authorizations_no_update_delete')).error).toBe(''); // ... which is why authenticity rests on the signature
  });

  it('M3. the provisioning template refuses unsafe or ambiguous input and changes nothing when it does', async () => {
    const db = new Client({ connectionString: urlFor(dbName) }); await db.connect(); clients.push(db);
    const members = async () => (await root.query("select pg_get_userbyid(roleid) r, pg_get_userbyid(member) m from pg_auth_members where pg_get_userbyid(roleid) like 'settlement%' and pg_get_userbyid(member) = any($1) order by 1,2", [[appLogin, recorderLogin]])).rows;
    expect(await members()).toEqual([]);
    const original = readFileSync(resolve(api, 'scripts/sql/settlement-authority-provisioning.sql'), 'utf8');
    expect(original).toContain('REPLACE_WITH_APPLICATION_LOGIN'); // the template ships unapplied and unusable
    expect((await tryQ(root, original)).error).toMatch(/PROVISIONING: both login names must be set/);
    expect((await tryQ(root, script(appLogin, appLogin))).error).toMatch(/must be different roles/);
    expect((await tryQ(root, script(appLogin, 'dev05_no_such_role'))).error).toMatch(/does not exist/);
    expect((await tryQ(root, script(migrator, recorderLogin))).error).toMatch(/has superuser, BYPASSRLS, CREATEROLE/);
    expect((await tryQ(root, script('settlement_consumer', recorderLogin))).error).toMatch(/cannot log in/);
    expect(await members()).toEqual([]);
  });

  it('M4. after provisioning, the application login can verify but not record, the recorder login can record but not verify as itself, and the full flow works with no superuser involved', async () => {
    expect((await tryQ(root, script(appLogin, recorderLogin))).error).toBe('');
    expect((await tryQ(root, script(appLogin, recorderLogin))).error).toBe(''); // idempotent
    const m = (await root.query("select pg_get_userbyid(roleid) r, pg_get_userbyid(member) m, inherit_option i, set_option s from pg_auth_members where pg_get_userbyid(roleid) like 'settlement%' and pg_get_userbyid(member) = any($1) order by 1,2", [[appLogin, recorderLogin]])).rows;
    expect(m).toEqual([{ r: 'settlement_consumer', m: appLogin, i: true, s: false }, { r: 'settlement_recorder', m: recorderLogin, i: false, s: true }]);
    const app = new Client({ connectionString: urlFor(dbName, appLogin) }); await app.connect(); clients.push(app);
    const rec = new Client({ connectionString: urlFor(dbName, recorderLogin) }); await rec.connect(); clients.push(rec);
    const fn = "select count(*)::int n from public.partner_credit_settlement_auth_read('00000000-0000-0000-0000-000000000001'::uuid,'00000000-0000-0000-0000-000000000002'::uuid)";
    expect((await tryQ(app, fn)).rows).toEqual([{ n: 0 }]); // may verify
    expect((await tryQ(app, 'SET ROLE settlement_recorder')).error).toMatch(/permission denied to set role/); // cannot assume the recorder
    expect((await tryQ(app, 'select * from partner_credit_settlement_authorizations')).error).toMatch(/permission denied/); // no table access through the consumer role
    expect((await tryQ(rec, 'insert into partner_credit_settlement_authorizations(id) values (gen_random_uuid())')).error).toMatch(/permission denied/); // holds no recording privilege until it switches
    expect((await tryQ(rec, fn)).error).toMatch(/permission denied for function/); // and does not inherit verification either
    expect((await tryQ(rec, 'SET ROLE settlement_recorder')).error).toBe(''); // it can switch, as the recorder code does for its single INSERT
    expect((await tryQ(rec, fn)).rows).toEqual([{ n: 0 }]); // as the recorder it can look up what it recorded
    expect((await tryQ(rec, 'RESET ROLE')).error).toBe('');
    expect((await tryQ(rec, 'SET ROLE settlement_consumer')).error).toMatch(/permission denied to set role/);
    expect((await tryQ(rec, 'SET ROLE settlement_authority_reader')).error).toMatch(/permission denied to set role/);
    // separation of duties is enforced on a second run
    await root.query(`grant settlement_recorder to ${appLogin}`);
    expect((await tryQ(root, script(appLogin, recorderLogin))).error).toMatch(/already holds settlement_recorder/);
    await root.query(`revoke settlement_recorder from ${appLogin}`);
    await root.query(`grant settlement_consumer to ${recorderLogin}`);
    expect((await tryQ(root, script(appLogin, recorderLogin))).error).toMatch(/already holds settlement_consumer/);
    await root.query(`revoke settlement_consumer from ${recorderLogin}`);
  });
});
