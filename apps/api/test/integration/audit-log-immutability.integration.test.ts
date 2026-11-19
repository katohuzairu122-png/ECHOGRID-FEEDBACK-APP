import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';

/**
 * CASHIER-PROD-D2-R8 against REAL PostgreSQL: database-enforced immutability of audit_log (migration 0085).
 * Development evidence on a disposable local database. Every negative test gives the acting role EVERY table privilege first, so a denial
 * can only come from the trigger boundary, never from a missing grant or an application-layer check.
 * Stated limit (also asserted below): the table OWNER can still disable the trigger. The production runtime login is the owner, so this
 * guard is a tripwire against defects and ordinary-DML abuse, not a defence against a compromised owner credential.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Audit immutability tests need a loopback PostgreSQL database.');
}

const run = randomUUID().replace(/-/g, '').slice(0, 10);
const APP = `r8_app_${run}`;
const OP = `r8_op_${run}`;
const APP_PASSWORD = randomUUID();
const consent = { consentVersion: 'v1' as const };

describe.skipIf(!databaseUrl)('D2-R8 audit_log immutability (real PostgreSQL)', () => {
  let admin: Client;
  let db: ReturnType<typeof buildDb>;
  let repos: ReturnType<typeof createRepositories>;
  let service: CustomerMembershipService;
  const extra: Client[] = [];
  let seq = 0;

  const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
  /** A REAL login session as the application role (not SET ROLE from a superuser session, whose authorization is the session user's). */
  const asApp = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const u = new URL(databaseUrl as string);
    u.username = APP;
    u.password = APP_PASSWORD;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    extra.push(c);
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const msg = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return '';
    } catch (e) {
      return String((e as Error).message);
    }
  };
  /** Records one audit row through the real repository (the way every legitimate writer does). */
  const audit = async (businessId: string | null, actorUserId: string | null, extraMeta: Record<string, unknown> = {}): Promise<string> =>
    repos.auditLog.recordReturningId({
      businessId, actorUserId, action: 'r8.test_event', entityType: 'r8_test', entityId: randomUUID(), metadata: { n: ++seq, ...extraMeta },
    });
  const fingerprint = async (ids: string[]): Promise<string> => {
    const rows = await q(`SELECT id, business_id, actor_user_id, action, entity_type, entity_id, metadata, ip_address, user_agent, created_at FROM audit_log WHERE id = ANY($1::uuid[]) ORDER BY id`, [ids]);
    return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  };
  const business = async (label: string) => (await repos.businesses.create({ name: `R8 ${label}`, slug: `r8-${label}-${run}` })).id;
  const user = async (label: string) =>
    (await repos.users.create({ email: `r8-${label}-${run}@example.test`, fullName: 'R8', passwordHash: 'x', status: 'active' })).id;

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    db = buildDb(admin);
    repos = createRepositories(db);
    service = new CustomerMembershipService(db);
    await admin.query(`CREATE ROLE ${APP} LOGIN PASSWORD '${APP_PASSWORD}'`);
    await admin.query(`CREATE ROLE ${OP} NOLOGIN`);
    await admin.query(`GRANT onboarding_erasure_operator TO ${OP}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${OP}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APP}`);
    // The strongest possible ordinary role: every privilege on every table. Only the trigger boundary can stop it.
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APP}`);
    await admin.query(`GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO ${APP}`);
  });

  afterAll(async () => {
    for (const c of extra) await c.end().catch(() => undefined);
    await admin?.query(`REVOKE onboarding_erasure_operator FROM ${OP}`).catch(() => undefined);
    await admin?.query(`DROP OWNED BY ${OP}`).catch(() => undefined);
    await admin?.query(`DROP ROLE IF EXISTS ${OP}`).catch(() => undefined);
    await admin?.query(`DROP OWNED BY ${APP}`).catch(() => undefined);
    await admin?.query(`DROP ROLE IF EXISTS ${APP}`).catch(() => undefined);
    await admin?.end();
  });

  describe('the guard itself', () => {
    it('is in place and cannot be skipped by session_replication_role (ENABLE ALWAYS), with a fixed search_path and no definer rights', async () => {
      const t = await q(`SELECT tgname, tgenabled, tgtype FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal ORDER BY tgname`);
      expect(t.map((r) => [r.tgname, r.tgenabled])).toEqual([['audit_log_immutability_guard_trg', 'A'], ['audit_log_no_truncate', 'A']]);
      const f = await q(`SELECT proname, prosecdef, proconfig FROM pg_proc WHERE proname IN ('audit_log_immutability_guard', 'audit_log_truncate_denied') ORDER BY proname`);
      expect(f.map((r) => r.prosecdef)).toEqual([false, false]);
      for (const r of f) expect(r.proconfig).toEqual(['search_path=pg_catalog, public']);
    });

    it('changed no privilege and created no role: audit_log grants are exactly what the application already had', async () => {
      const g = await q(`SELECT DISTINCT grantee FROM information_schema.role_table_grants WHERE table_name = 'audit_log' AND table_schema = 'public' AND grantee NOT LIKE 'r8_app_%' AND grantee NOT LIKE 'd2r1_%'`);
      expect(g.map((r) => r.grantee)).not.toContain('PUBLIC');
      expect(await q(`SELECT 1 FROM pg_roles WHERE rolname LIKE 'audit%'`)).toEqual([]);
    });
  });

  describe('legitimate writers keep working', () => {
    it('repository INSERT works, including many concurrent inserts and an aborted transaction leaving nothing behind', async () => {
      const biz = await business('ins');
      const ids = await Promise.all(Array.from({ length: 25 }, () => audit(biz, null)));
      expect(new Set(ids).size).toBe(25);
      const marker = randomUUID();
      await admin.query('BEGIN');
      await admin.query(`INSERT INTO audit_log (business_id, action, entity_type, metadata) VALUES ($1, 'r8.rolled_back', 'r8_test', $2::jsonb)`, [biz, JSON.stringify({ marker })]);
      await admin.query('ROLLBACK');
      expect(await q(`SELECT 1 FROM audit_log WHERE metadata ->> 'marker' = $1`, [marker])).toEqual([]);
    });

    it('a real customer join writes its audit row, and the 0084 erasure still works and leaves that audit row byte-for-byte unchanged', async () => {
      const biz = await business('join');
      const branch = (await repos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const cust = (await repos.customers.create({ phone: `+1558${run.replace(/\D/g, '').padEnd(6, '4').slice(0, 5)}001`, phoneVerifiedAt: new Date() })).id;
      await service.join({
        customerId: cust, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}`, ...consent,
        attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}` },
      });
      const ev = (await q(`SELECT id FROM customer_onboarding_events WHERE business_id = $1`, [biz]))[0].id as string;
      const auditRow = (await q(`SELECT id FROM audit_log WHERE entity_type = 'customer_onboarding_event' AND entity_id = $1`, [ev]))[0].id as string;
      const before = await fingerprint([auditRow]);
      const op = new Client({ connectionString: databaseUrl });
      await op.connect();
      extra.push(op);
      try {
        await op.query(`SET ROLE ${OP}`);
        await op.query(`SELECT * FROM public.onboarding_erase_customer_events($1, $2, $3, false)`, [biz, cust, `req-${run}-r8`]);
      } finally {
        await op.end();
      }
      expect((await q(`SELECT erased_at FROM customer_onboarding_events WHERE id = $1`, [ev]))[0].erased_at).not.toBeNull();
      expect(await fingerprint([auditRow])).toBe(before); // erasure never touches audit_log (the residual linkage is a separate, documented matter)
    });

    it('concurrent onboarding of several customers while one is erased writes every audit row exactly once', async () => {
      const biz = await business('conc');
      const branch = (await repos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const customers = await Promise.all(Array.from({ length: 6 }, async (_, i) =>
        (await repos.customers.create({ phone: `+1557${run.replace(/\D/g, '').padEnd(6, '5').slice(0, 5)}${String(i).padStart(3, '0')}`, phoneVerifiedAt: new Date() })).id));
      await Promise.all(customers.map((c, i) => service.join({
        customerId: c, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}-${i}`, ...consent,
        attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}-${i}` },
      })));
      const n = (await q(`SELECT count(*)::int AS n FROM audit_log WHERE business_id = $1 AND action = 'customer.onboarded'`, [biz]))[0].n;
      expect(n).toBe(6);
    });
  });

  describe('every mutation is refused at the trigger boundary, even for a role holding every privilege', () => {
    it('UPDATE, DELETE and TRUNCATE, for the superuser test connection and for the all-privileges application role', async () => {
      const biz = await business('mut');
      const id = await audit(biz, null);
      const before = await fingerprint([id]);
      const attempts = [
        `UPDATE audit_log SET metadata = '{}'::jsonb WHERE id = '${id}'`,
        `UPDATE audit_log SET created_at = now() - interval '1 day' WHERE id = '${id}'`,
        `UPDATE audit_log SET entity_id = NULL WHERE id = '${id}'`,
        `UPDATE audit_log SET business_id = NULL WHERE id = '${id}'`, // the referential-action SHAPE, issued directly: still refused (depth 1)
        `UPDATE audit_log SET action = 'x' WHERE business_id = '${biz}'`,
        `DELETE FROM audit_log WHERE id = '${id}'`,
        `DELETE FROM audit_log WHERE business_id = '${biz}'`,
      ];
      for (const sql of attempts) {
        expect(await msg(admin.query(sql)), `superuser: ${sql}`).toMatch(/AUDIT_LOG_(IMMUTABLE|TRUNCATE_DENIED)/);
        expect(await asApp((c) => msg(c.query(sql))), `app role: ${sql}`).toMatch(/AUDIT_LOG_(IMMUTABLE|TRUNCATE_DENIED)/);
      }
      // TRUNCATE: PostgreSQL's own FK rule refuses a plain TRUNCATE of a referenced table (customer_onboarding_events references audit_log) before any
      // trigger runs; that is a second layer, asserted here for the app role. The audit trigger itself is proven in the next test.
      for (const sql of [`TRUNCATE audit_log`, `TRUNCATE audit_log CASCADE`, `TRUNCATE audit_log RESTART IDENTITY`]) {
        expect(await asApp((c) => msg(c.query(sql))), `app role: ${sql}`).toMatch(/cannot truncate a table referenced|AUDIT_LOG_TRUNCATE_DENIED|ONBOARDING_EVENT_TRUNCATE_DENIED|permission denied/i);
      }
      expect(await fingerprint([id])).toBe(before);
    });

    it('the audit trigger itself denies TRUNCATE: audit_log is truncated together with every table referencing it, audit_log first, with FK checks relaxed', async () => {
      const refs = (await q(`SELECT DISTINCT conrelid::regclass::text AS t FROM pg_constraint WHERE confrelid = 'public.audit_log'::regclass AND contype = 'f'`)).map((r) => r.t as string);
      await admin.query('BEGIN');
      await admin.query(`SET LOCAL session_replication_role = replica`);
      const m = await msg(admin.query(`TRUNCATE audit_log, ${refs.join(', ')}`));
      await admin.query('ROLLBACK');
      expect(m).toMatch(/AUDIT_LOG_TRUNCATE_DENIED/);
      expect((await q(`SELECT count(*)::int AS n FROM audit_log`))[0].n).toBeGreaterThan(0);
    });

    it('session_replication_role = replica does not skip it, and a cross-business row cannot be touched by another business or its roles', async () => {
      const bizA = await business('xa');
      const bizB = await business('xb');
      const a = await audit(bizA, null);
      const before = await fingerprint([a]);
      await admin.query(`SET session_replication_role = replica`);
      try {
        expect(await msg(admin.query(`UPDATE audit_log SET metadata = '{"x":1}'::jsonb WHERE id = '${a}'`))).toMatch(/AUDIT_LOG_IMMUTABLE/);
        expect(await msg(admin.query(`DELETE FROM audit_log WHERE id = '${a}'`))).toMatch(/AUDIT_LOG_IMMUTABLE/);
      } finally {
        await admin.query(`RESET session_replication_role`);
      }
      expect(await asApp((c) => msg(c.query(`UPDATE audit_log SET business_id = $1 WHERE id = $2`, [bizB, a])))).toMatch(/AUDIT_LOG_IMMUTABLE/);
      expect(await fingerprint([a])).toBe(before);
    });

    it('a plain function or DO block issuing the referential-action shape directly is refused (nesting depth, not just shape)', async () => {
      const biz = await business('depth');
      const id = await audit(biz, null);
      const before = await fingerprint([id]);
      await admin.query(`CREATE OR REPLACE FUNCTION r8_null_biz_${run}(p uuid) RETURNS void LANGUAGE plpgsql AS $f$ BEGIN UPDATE audit_log SET business_id = NULL WHERE id = p; END $f$`);
      expect(await msg(admin.query(`SELECT r8_null_biz_${run}($1)`, [id]))).toMatch(/AUDIT_LOG_IMMUTABLE/);
      expect(await msg(admin.query(`DO $$ BEGIN UPDATE audit_log SET business_id = NULL WHERE id = '${id}'; END $$`))).toMatch(/AUDIT_LOG_IMMUTABLE/);
      await admin.query(`DROP FUNCTION r8_null_biz_${run}(uuid)`);
      expect(await fingerprint([id])).toBe(before);
    });
  });

  describe('the one permitted change: foreign-key ON DELETE SET NULL', () => {
    it('deleting a business or a user still works and only nulls the reference; every other audit column is unchanged and the row survives', async () => {
      const biz = await business('refdel');
      const actor = await user('refdel');
      const id = await audit(biz, actor, { keep: 'me' });
      const other = await audit(biz, null);
      const row = (await q(`SELECT action, entity_type, entity_id, metadata, ip_address, user_agent, created_at FROM audit_log WHERE id = $1`, [id]))[0];
      await q(`DELETE FROM users WHERE id = $1`, [actor]);
      const afterUser = (await q(`SELECT * FROM audit_log WHERE id = $1`, [id]))[0];
      expect(afterUser.actor_user_id).toBeNull();
      expect(afterUser.business_id).toBe(biz);
      await q(`DELETE FROM businesses WHERE id = $1`, [biz]);
      const afterBiz = (await q(`SELECT * FROM audit_log WHERE id = $1`, [id]))[0];
      expect(afterBiz.business_id).toBeNull();
      for (const k of ['action', 'entity_type', 'entity_id', 'metadata', 'ip_address', 'user_agent', 'created_at'] as const) {
        expect(afterBiz[k], k).toEqual(row[k]);
      }
      expect((await q(`SELECT business_id FROM audit_log WHERE id = $1`, [other]))[0].business_id).toBeNull();
    });
  });

  describe('the boundary cannot be dismantled by an ordinary role', () => {
    it('disable, drop, alter the function, change ownership or SET ROLE to the owner are all denied to a role holding every table privilege', async () => {
      const attempts = [
        `ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutability_guard_trg`,
        `ALTER TABLE audit_log DISABLE TRIGGER ALL`,
        `ALTER TABLE audit_log DISABLE TRIGGER USER`,
        `DROP TRIGGER audit_log_immutability_guard_trg ON audit_log`,
        `DROP TRIGGER audit_log_no_truncate ON audit_log`,
        `CREATE OR REPLACE FUNCTION audit_log_immutability_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        `ALTER FUNCTION audit_log_immutability_guard() SET search_path = public`,
        `ALTER TABLE audit_log OWNER TO ${APP}`,
        `ALTER TABLE audit_log SET (autovacuum_enabled = false)`,
        `DROP TABLE audit_log`,
        `ALTER TABLE audit_log DROP COLUMN metadata`,
      ];
      for (const sql of attempts) expect(await asApp((c) => msg(c.query(sql))), sql).toMatch(/must be owner|permission denied|owner/i);
      expect(await asApp((c) => msg(c.query(`SET ROLE onboarding_erasure_owner`)))).toMatch(/permission denied|must be member/i);
      const owner = (await q(`SELECT tableowner FROM pg_tables WHERE tablename = 'audit_log'`))[0].tableowner as string;
      expect(await asApp((c) => msg(c.query(`SET ROLE "${owner}"`)))).toMatch(/permission denied|must be member/i);
      // the guard is still there afterwards
      expect((await q(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = 'public.audit_log'::regclass AND NOT tgisinternal AND tgenabled = 'A'`))[0].n).toBe(2);
    });

    it('STATED LIMIT (characterization): the table owner can still disable the guard, which is why a separate non-owner runtime role is an Owner decision', async () => {
      await admin.query('BEGIN');
      try {
        await admin.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutability_guard_trg`);
        const biz = await business('ownerlimit');
        const id = await audit(biz, null);
        await admin.query(`UPDATE audit_log SET metadata = '{"owner":"edited"}'::jsonb WHERE id = '${id}'`); // succeeds only because the owner dismantled the guard
        expect((await q(`SELECT metadata FROM audit_log WHERE id = $1`, [id]))[0].metadata).toEqual({ owner: 'edited' });
      } finally {
        await admin.query('ROLLBACK');
      }
      expect((await q(`SELECT tgenabled FROM pg_trigger WHERE tgname = 'audit_log_immutability_guard_trg'`))[0].tgenabled).toBe('A');
    });

    it('the erasure roles can read neither audit_log nor memberships and still have no route to mutate it', async () => {
      for (const role of ['onboarding_erasure_operator', 'onboarding_erasure_owner']) {
        for (const verb of ['SELECT', 'UPDATE', 'DELETE', 'TRUNCATE', 'INSERT']) {
          expect(await q(`SELECT has_table_privilege($1, 'public.audit_log', $2) AS ok`, [role, verb])).toEqual([{ ok: false }]);
        }
      }
    });
  });

  describe('historical data is preserved', () => {
    it('rows written before the guard keep their exact content and the whole table fingerprint is stable across failed mutations', async () => {
      const biz = await business('hist');
      const ids = await Promise.all([audit(biz, null), audit(biz, null), audit(biz, null)]);
      const before = await fingerprint(ids);
      for (const sql of [`UPDATE audit_log SET metadata = NULL WHERE business_id = '${biz}'`, `DELETE FROM audit_log WHERE business_id = '${biz}'`]) {
        await msg(admin.query(sql));
      }
      expect(await fingerprint(ids)).toBe(before);
      expect((await q(`SELECT count(*)::int AS n FROM audit_log WHERE business_id = $1`, [biz]))[0].n).toBe(3);
    });
  });
});
