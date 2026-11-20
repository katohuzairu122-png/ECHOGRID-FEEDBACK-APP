import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { RoleProvisioningService } from '../../src/rbac/role-provisioning.service';

/**
 * CASHIER-PROD-R8-G against REAL PostgreSQL: the least-privilege application runtime role.
 * The committed provisioning SQL is applied to a disposable database, the committed verification SQL must return no rows, and every
 * attack below is made through a genuine non-owner LOGIN session (not SET ROLE from a superuser session, whose authorization is the
 * session user's). Each denial is asserted at the privilege boundary itself (PostgreSQL's own permission error), not at a trigger or an
 * application check. Development evidence only: nothing here touches a shared database or a production credential.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Runtime role tests need a loopback PostgreSQL database.');
}

const api = resolve(__dirname, '../..');
const dir = resolve(api, 'scripts/runtime-role');
const manifest = JSON.parse(readFileSync(resolve(dir, 'runtime-role-manifest.json'), 'utf8')) as {
  role: string; sequences: string[]; tables: Record<string, { class: string; verbs: string[] }>;
};
const GROUP = manifest.role;
const run = randomUUID().replace(/-/g, '').slice(0, 10);
const LOGIN = `r8g_login_${run}`;
const PASSWORD = randomBytes(18).toString('hex');
const consent = { consentVersion: 'v1' as const };

describe.skipIf(!databaseUrl)('R8-G non-owner application runtime role (real PostgreSQL)', () => {
  let admin: Client;
  let adminRepos: ReturnType<typeof createRepositories>;
  const opened: Client[] = [];

  const url = (user: string, password: string) => { const u = new URL(databaseUrl as string); u.username = user; u.password = password; return u.toString(); };
  const runtimeClient = async (): Promise<Client> => {
    const c = new Client({ connectionString: url(LOGIN, PASSWORD) });
    await c.connect();
    opened.push(c);
    return c;
  };
  const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
  const msg = async (p: Promise<unknown>): Promise<string> => { try { await p; return ''; } catch (e) { return String((e as Error).message); } };
  const rows = async (sql: string) => (await admin.query(sql.replaceAll(":'runtime_login'", `'${LOGIN}'`))).rows;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    adminRepos = createRepositories(buildDb(admin));
    await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    const provisioning = readFileSync(resolve(dir, 'provision-runtime-role.sql'), 'utf8').replaceAll('REPLACE_WITH_RUNTIME_LOGIN', LOGIN);
    await admin.query(provisioning);
    await admin.query(provisioning); // idempotent: a second run changes nothing and does not fail
  });

  afterAll(async () => {
    for (const c of opened) await c.end().catch(() => undefined);
    await admin?.query(`REVOKE ${GROUP} FROM ${LOGIN}`).catch(() => undefined);
    await admin?.query(`DROP OWNED BY ${LOGIN}`).catch(() => undefined);
    await admin?.query(`DROP ROLE IF EXISTS ${LOGIN}`).catch(() => undefined);
    await admin?.end();
  });

  describe('provisioning and the manifest', () => {
    it('the committed SQL equals what the manifest generates (no drift), and the generator is deterministic', () => {
      execFileSync(process.execPath, [resolve(dir, 'generate.mjs'), '--check'], { cwd: api, stdio: 'pipe' });
    });

    it('every table in the database is classified in the manifest, and every manifest table exists (a new table cannot silently gain or miss access)', async () => {
      const real = (await q(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).map((r) => r.tablename as string);
      const listed = Object.keys(manifest.tables).sort();
      expect(real.filter((t) => !listed.includes(t))).toEqual([]);
      expect(listed.filter((t) => !real.includes(t))).toEqual([]);
      for (const m of Object.values(manifest.tables)) expect(['RUNTIME', 'NO_ACCESS']).toContain(m.class);
    });

    it('independent pins (not derived from the manifest): audit history is INSERT/SELECT only, the erasure audit is untouchable, and no table ever grants TRUNCATE, REFERENCES or TRIGGER', async () => {
      const held = async (table: string) => {
        const out: string[] = [];
        for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          if ((await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [LOGIN, `public.${table}`, verb]))[0].ok) out.push(verb);
        }
        return out.sort();
      };
      expect(await held('audit_log')).toEqual(['INSERT', 'SELECT']);
      expect(await held('onboarding_erasure_operations')).toEqual([]);
      expect(await held('customer_onboarding_events')).toEqual(expect.not.arrayContaining(['UPDATE', 'DELETE']));
      for (const t of Object.keys(manifest.tables)) expect(await held(t), t).toEqual(expect.not.arrayContaining(['TRUNCATE', 'REFERENCES', 'TRIGGER']));
    });

    it('every table with forced row-level security is NO_ACCESS for the runtime (those families have dedicated roles and policies)', async () => {
      const forced = (await q(`SELECT relname FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND relforcerowsecurity`)).map((r) => r.relname as string);
      expect(forced.length).toBeGreaterThan(0);
      for (const t of forced) expect(manifest.tables[t]?.class, t).toBe('NO_ACCESS');
    });

    it('the group role and the login have no dangerous attribute; the group is a member of nothing; the login only of the group', async () => {
      const a = await q(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname IN ($1, $2) ORDER BY 1`, [GROUP, LOGIN]);
      expect(a).toHaveLength(2);
      for (const r of a) expect([r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls]).toEqual([false, false, false, false, false]);
      expect(a.find((r) => r.rolname === GROUP)!.rolcanlogin).toBe(false);
      const m = await q(`SELECT r.rolname AS member, g.rolname AS granted FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid WHERE r.rolname IN ($1, $2)`, [GROUP, LOGIN]);
      expect(m).toEqual([{ member: LOGIN, granted: GROUP }]);
    });

    it('every verification query returns ZERO rows (attributes, memberships, ownership, no CREATE, no privilege outside the manifest, no definer function, only manifest sequences)', async () => {
      const sql = readFileSync(resolve(dir, 'verify-runtime-role.sql'), 'utf8').replaceAll(":'runtime_login'", `'${LOGIN}'`);
      // split on the top-level statements (each ends with ';' at line end after the comments)
      const statements = sql.split(/;\s*\n/).map((s) => s.replace(/^(\s*--.*\n)+/gm, '').trim()).filter((s) => /^SELECT/i.test(s));
      expect(statements.length).toBeGreaterThanOrEqual(7);
      for (const s of statements) expect(await q(s), s.slice(0, 80)).toEqual([]);
    });

    it('the privileges actually held equal the manifest exactly, table by table (no more, no less)', async () => {
      for (const [table, m] of Object.entries(manifest.tables)) {
        const held: string[] = [];
        for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          const r = await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [LOGIN, `public.${table}`, verb]);
          if (r[0].ok) held.push(verb);
        }
        expect(held.sort(), table).toEqual(m.class === 'RUNTIME' ? [...m.verbs].sort() : []);
      }
    });
  });

  describe('the runtime cannot dismantle the audit and security structures (real LOGIN session)', () => {
    it('cannot disable, drop or replace the audit guards, change ownership, alter or drop protected tables, or add/drop columns', async () => {
      const c = await runtimeClient();
      const attempts = [
        `ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutability_guard_trg`,
        `ALTER TABLE audit_log DISABLE TRIGGER ALL`,
        `ALTER TABLE audit_log DISABLE TRIGGER USER`,
        `DROP TRIGGER audit_log_immutability_guard_trg ON audit_log`,
        `DROP TRIGGER audit_log_no_truncate ON audit_log`,
        `CREATE OR REPLACE FUNCTION audit_log_immutability_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        `ALTER FUNCTION audit_log_immutability_guard() OWNER TO ${LOGIN}`,
        `ALTER FUNCTION audit_log_immutability_guard() SET search_path = public`,
        `DROP FUNCTION audit_log_immutability_guard() CASCADE`,
        `ALTER TABLE audit_log OWNER TO ${LOGIN}`,
        `ALTER TABLE audit_log ADD COLUMN pwned text`,
        `ALTER TABLE audit_log DROP COLUMN metadata`,
        `ALTER TABLE customer_onboarding_events DISABLE TRIGGER ALL`,
        `ALTER TABLE users DISABLE TRIGGER ALL`,
        `DROP TABLE audit_log CASCADE`,
        `DROP TABLE customer_onboarding_events CASCADE`,
        `CREATE TABLE public.r8g_shadow (id int)`,
        `CREATE TRIGGER r8g_t BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_immutability_guard()`,
        `CREATE SCHEMA r8g_s`,
        `CREATE FUNCTION public.r8g_f() RETURNS int LANGUAGE sql AS 'select 1'`,
      ];
      for (const sql of attempts) expect(await msg(c.query(sql)), sql).toMatch(/must be owner|permission denied/i);
      expect((await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal AND tgenabled = 'A'`))[0].n).toBe(2);
    });

    it('is denied TRUNCATE, UPDATE and DELETE on audit history at the PRIVILEGE boundary (not by a trigger), and nothing changes', async () => {
      const biz = (await adminRepos.businesses.create({ name: `R8G ${run}`, slug: `r8g-${run}` })).id;
      const id = await adminRepos.auditLog.recordReturningId({ businessId: biz, actorUserId: null, action: 'r8g.history', entityType: 'r8g', entityId: randomUUID(), metadata: { n: 1 } });
      const before = JSON.stringify(await q(`SELECT * FROM audit_log WHERE id = $1`, [id]));
      const c = await runtimeClient();
      for (const sql of [`TRUNCATE audit_log`, `TRUNCATE audit_log CASCADE`, `UPDATE audit_log SET metadata = '{}'::jsonb WHERE id = '${id}'`, `UPDATE audit_log SET business_id = NULL WHERE id = '${id}'`, `DELETE FROM audit_log WHERE id = '${id}'`, `DELETE FROM audit_log`]) {
        const m = await msg(c.query(sql));
        expect(m, sql).toMatch(/permission denied for table audit_log/);
        expect(m, sql).not.toMatch(/AUDIT_LOG_/); // stopped before any trigger could run
      }
      expect(JSON.stringify(await q(`SELECT * FROM audit_log WHERE id = $1`, [id]))).toBe(before);
    });

    it('cannot assume the owner, the migrator, the erasure owner or the erasure operator, nor any role', async () => {
      const c = await runtimeClient();
      const owner = (await q(`SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log'`))[0].tableowner as string;
      for (const role of [owner, 'postgres', 'onboarding_erasure_owner', 'onboarding_erasure_operator', 'settlement_recorder', 'stripe_read_auth_lifecycle', 'signed_evidence_lifecycle']) {
        expect(await msg(c.query(`SET ROLE "${role}"`)), role).toMatch(/permission denied to set role/i);
      }
      expect(await msg(c.query(`SET SESSION AUTHORIZATION "${owner}"`))).toMatch(/permission denied/i);
      expect((await c.query(`SELECT current_user, session_user`)).rows[0]).toEqual({ current_user: LOGIN, session_user: LOGIN });
    });

    it('cannot create roles, escalate attributes, or grant itself anything (effective privileges are unchanged afterwards)', async () => {
      const c = await runtimeClient();
      expect(await msg(c.query(`CREATE ROLE r8g_evil_${run} SUPERUSER`))).toMatch(/permission denied/i);
      expect(await msg(c.query(`CREATE ROLE r8g_evil_${run}`))).toMatch(/permission denied/i);
      expect(await msg(c.query(`ALTER ROLE ${LOGIN} SUPERUSER`))).toMatch(/permission denied|must be/i);
      expect(await msg(c.query(`ALTER ROLE ${LOGIN} BYPASSRLS`))).toMatch(/permission denied|must be/i);
      expect(await msg(c.query(`GRANT postgres TO ${LOGIN}`))).toMatch(/permission denied|must have|grant option|ADMIN/i);
      expect(await msg(c.query(`GRANT onboarding_erasure_operator TO ${LOGIN}`))).toMatch(/permission denied|must have|grant option|ADMIN/i);
      // a GRANT without grant option is only a warning in PostgreSQL: the assertion that matters is that nothing was gained
      await msg(c.query(`GRANT ALL ON TABLE audit_log TO ${LOGIN}`));
      await msg(c.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${LOGIN}`)); // errors outright for a non-owner; either way nothing is gained
      await msg(c.query(`GRANT ALL ON SCHEMA public TO ${LOGIN}`));
      for (const verb of ['UPDATE', 'DELETE', 'TRUNCATE']) expect((await q(`SELECT has_table_privilege($1, 'audit_log', $2) AS ok`, [LOGIN, verb]))[0].ok, verb).toBe(false);
      expect((await q(`SELECT has_table_privilege($1, 'stripe_read_authorizations', 'SELECT') AS ok`, [LOGIN]))[0].ok).toBe(false);
      expect(await msg(c.query(`SET session_replication_role = replica`))).toMatch(/permission denied/i);
      expect(await msg(c.query(`ALTER SYSTEM SET log_statement = 'none'`))).toMatch(/permission denied/i);
    });

    it('cannot read or write the forced-RLS financial/evidence families or the erasure audit, and cannot call privileged definer functions, including the 0084 erasure', async () => {
      const c = await runtimeClient();
      for (const t of ['stripe_read_authorizations', 'stripe_read_policy_changes', 'signed_evidence_records', 'settlement_custody_authorization_links', 'partner_credit_settlement_authorizations', 'onboarding_erasure_operations']) {
        expect(await msg(c.query(`SELECT 1 FROM ${t} LIMIT 1`)), `select ${t}`).toMatch(/permission denied/i);
        expect(await msg(c.query(`DELETE FROM ${t}`)), `delete ${t}`).toMatch(/permission denied/i);
      }
      // RLS cannot be sidestepped either: turning row_security off does not grant a table the role holds no privilege on
      await c.query(`SET row_security = off`).catch(() => undefined);
      expect(await msg(c.query(`SELECT 1 FROM stripe_read_authorizations LIMIT 1`))).toMatch(/permission denied|row-level security/i);
      expect((await q(`SELECT has_table_privilege($1, 'stripe_read_authorizations', 'SELECT') AS ok`, [LOGIN]))[0].ok).toBe(false);
      expect(await msg(c.query(`SELECT * FROM public.onboarding_erase_customer_events($1, $2, $3, false)`, [randomUUID(), randomUUID(), `req-${run}`]))).toMatch(/permission denied for function/i);
      const defs = (await q(`SELECT proname FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef`)).map((r) => r.proname as string);
      expect(defs.length).toBeGreaterThan(0);
      for (const f of defs) expect((await q(`SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS ok FROM pg_proc p WHERE p.proname = $2 AND p.pronamespace = 'public'::regnamespace`, [LOGIN, f])).every((r) => r.ok === false), f).toBe(true);
    });
  });

  describe('the runtime still does its legitimate work (real services under the non-owner login)', () => {
    it('audit INSERT succeeds, including 25 concurrent sessions, and the runtime can read what it wrote but not alter it', async () => {
      const biz = (await adminRepos.businesses.create({ name: `R8G concurrent ${run}`, slug: `r8g-c-${run}` })).id;
      const sessions = await Promise.all(Array.from({ length: 25 }, () => runtimeClient()));
      const ids = await Promise.all(sessions.map((c, i) =>
        c.query(`INSERT INTO audit_log (business_id, action, entity_type, metadata) VALUES ($1, 'r8g.concurrent', 'r8g', $2::jsonb) RETURNING id`, [biz, JSON.stringify({ i })]).then((r) => r.rows[0].id as string)));
      expect(new Set(ids).size).toBe(25);
      expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE business_id = $1 AND action = 'r8g.concurrent'`, [biz]))[0].n).toBe(25);
      const c = sessions[0]!;
      expect((await c.query(`SELECT count(*)::int AS n FROM audit_log WHERE business_id = $1`, [biz])).rows[0].n).toBe(25);
      expect(await msg(c.query(`UPDATE audit_log SET action = 'x' WHERE business_id = $1`, [biz]))).toMatch(/permission denied/i);
    });

    it('registration, business, branch, role provisioning, customer membership join and leave (with its audit and onboarding event) all work', async () => {
      const c = await runtimeClient();
      const repos = createRepositories(buildDb(c));
      const owner = (await repos.users.create({ email: `r8g-owner-${run}@example.test`, fullName: 'Owner', passwordHash: 'x', status: 'active' })).id;
      const biz = (await repos.businesses.create({ name: `R8G biz ${run}`, slug: `r8g-b-${run}` })).id;
      const branch = (await repos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const roles = await new RoleProvisioningService(repos).seedDefaultRoles(biz, owner);
      await repos.userBusinessRoles.grant({ userId: owner, businessId: biz, branchId: null, roleId: roles.Owner, createdBy: owner });
      const customer = (await repos.customers.create({ phone: `+1556${run.replace(/\D/g, '').padEnd(6, '7').slice(0, 5)}001`, phoneVerifiedAt: new Date() })).id;
      const service = new CustomerMembershipService(buildDb(c));
      const joined = await service.join({
        customerId: customer, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}`, ...consent,
        attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}` },
      });
      expect(joined.membership.id).toBeTruthy();
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1`, [biz]))[0].n).toBe(1);
      expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE business_id = $1 AND action = 'customer.onboarded'`, [biz]))[0].n).toBe(1);
      await service.leave(customer, biz);
      expect((await q(`SELECT status FROM business_customer_memberships WHERE business_id = $1`, [biz]))[0].status).not.toBe('active');
    });

    it('the relationship advisory lock protocol still serializes concurrent joins and leaves under the runtime role', async () => {
      const biz = (await adminRepos.businesses.create({ name: `R8G lock ${run}`, slug: `r8g-l-${run}` })).id;
      const branch = (await adminRepos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const customer = (await adminRepos.customers.create({ phone: `+1555${run.replace(/\D/g, '').padEnd(6, '8').slice(0, 5)}001`, phoneVerifiedAt: new Date() })).id;
      const clients = await Promise.all(Array.from({ length: 6 }, () => runtimeClient()));
      const results = await Promise.allSettled(clients.map((c, i) => new CustomerMembershipService(buildDb(c)).join({
        customerId: customer, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}-l${i}`, ...consent,
        attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}-l${i}` },
      })));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect((await q(`SELECT count(*)::int AS n FROM business_customer_memberships WHERE business_id = $1 AND customer_id = $2`, [biz, customer]))[0].n).toBe(1);
    });
  });
});
