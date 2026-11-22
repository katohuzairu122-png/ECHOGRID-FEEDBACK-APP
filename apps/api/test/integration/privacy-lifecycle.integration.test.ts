import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';
import { appDbOf } from '../helpers/runtime-db';

/**
 * D2-FINAL (migration 0086) against REAL PostgreSQL: verified privacy-request workflow, customer shell anonymization, legal holds and the
 * retention registry. Development evidence on a disposable database. Nothing here is a legal or retention approval: retention periods used
 * below are TEST FIXTURES only, and no policy is ever enabled outside this disposable database.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('Privacy lifecycle tests need a loopback PostgreSQL database.');
}

const run = randomUUID().replace(/-/g, '').slice(0, 10);
const OP = `d2f_op_${run}`;
const APPLOGIN = `d2f_app_${run}`;
const APPPASS = randomBytes(18).toString('hex');
const consent = { consentVersion: 'v1' as const };

describe.skipIf(!databaseUrl)('D2-FINAL privacy lifecycle (real PostgreSQL)', () => {
  let admin: Client;
  let repos: ReturnType<typeof createRepositories>;
  let service: CustomerMembershipService;
  const extra: Client[] = [];
  let seq = 0;
  /** A policy version no earlier run on a reused database can have used (the unique key is category + version). */
  const freshVersion = () => 10_000 + Math.floor(Math.random() * 2_000_000_000);
  let support: string; let admin1: string; let admin2: string; let inactive: string; let ordinary: string;

  const connect = async (): Promise<Client> => { const c = new Client({ connectionString: databaseUrl }); await c.connect(); extra.push(c); return c; };
  const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
  const msg = async (p: Promise<unknown>): Promise<string> => { try { await p; return ''; } catch (e) { const err = e as Error & { cause?: { message?: string } }; return `${err.message} ${err.cause?.message ?? ''}`; } };
  const asOperator = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const c = await connect();
    try { await c.query(`SET ROLE ${OP}`); return await fn(c); } finally { await c.end(); }
  };
  const asAppLogin = async <T>(fn: (c: Client) => Promise<T>): Promise<T> => {
    const u = new URL(databaseUrl as string); u.username = APPLOGIN; u.password = APPPASS;
    const c = new Client({ connectionString: u.toString() });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  };
  const call = (sql: string, values: unknown[] = []) => asOperator(async (c) => (await c.query(sql, values)).rows);

  let phoneSeq = 0;
  const customer = async (extraPii = true): Promise<{ id: string; phone: string; email: string }> => {
    const phone = `+1554${run.replace(/\D/g, '').padEnd(6, '2').slice(0, 5)}${String(++phoneSeq).padStart(3, '0')}`;
    const email = `d2f-${run}-${phoneSeq}@example.test`;
    const id = (await repos.customers.create({ phone, phoneVerifiedAt: new Date() })).id;
    if (extraPii) await q(`UPDATE customers SET full_name = 'Real Name', email = $2, birthday = '1990-05-05', preferred_locale = 'en' WHERE id = $1`, [id, email]);
    return { id, phone, email };
  };
  interface World { biz: string; b1: string }
  const world = async (label: string): Promise<World> => {
    const biz = (await repos.businesses.create({ name: `D2F ${label}`, slug: `d2f-${label}-${run}` })).id;
    const b1 = (await repos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
    return { biz, b1 };
  };
  const join = (w: World, customerId: string, tx = service) =>
    tx.join({ customerId, businessId: w.biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}-${++seq}`, ...consent, attribution: { source: 'business_qr', branchId: w.b1, reference: `qr-${run}-${seq}` } });
  const platformUser = async (label: string, role: string | null, status = 'active') =>
    (await q(`INSERT INTO users (email, full_name, password_hash, status, platform_role) VALUES ($1, $2, 'x', $3, $4) RETURNING id`, [`d2f-${label}-${run}@example.test`, label, status, role]))[0].id as string;

  /** Drives a request to the point just before approval; returns its id. */
  const toRetentionAssessment = async (customerId: string, channel = 'platform_assisted', ref = `rq-${run}-${++seq}`) => {
    const id = (await call(`SELECT public.privacy_request_submit($1, $2, $3) AS id`, [customerId, ref, channel]))[0].id as string;
    await call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, support]);
    await call(`SELECT public.privacy_request_record_verification($1, $2, $3, $4)`, [id, channel === 'customer_authenticated' ? 'customer_reauthentication' : 'out_of_band_platform_verified', `ev-${run}-${++seq}`, support]);
    await call(`SELECT public.privacy_request_advance($1, 'scope_assessment', $2)`, [id, support]);
    await call(`SELECT public.privacy_request_advance($1, 'retention_assessment', $2)`, [id, support]);
    return id;
  };
  const approved = async (customerId: string, opts: { sever?: boolean; feedback?: boolean; conv?: boolean } = {}) => {
    const id = await toRetentionAssessment(customerId);
    await call(`SELECT public.privacy_request_approve($1, $2, $3, $4, $5, $6)`, [id, admin1, `ap-${run}-${++seq}`, opts.sever ?? false, opts.feedback ?? false, opts.conv ?? false]);
    return id;
  };
  const anonymize = (id: string) => call(`SELECT * FROM public.privacy_anonymize_customer($1)`, [id]).then((r) => r[0] as Record<string, unknown>);
  const reqRow = async (id: string) => (await q(`SELECT * FROM privacy_requests WHERE id = $1`, [id]))[0];

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = buildDb(admin);
    repos = createRepositories(db);
    service = new CustomerMembershipService(appDbOf(db));
    await admin.query(`CREATE ROLE ${OP} NOLOGIN`);
    await admin.query(`GRANT customer_privacy_operator TO ${OP}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${OP}`);
    await admin.query(`CREATE ROLE ${APPLOGIN} LOGIN PASSWORD '${APPPASS}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${APPLOGIN}`);
    await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO ${APPLOGIN}`); // every TABLE privilege, no function EXECUTE: only the function/trigger boundary can stop it
    support = await platformUser('support', 'support');
    admin1 = await platformUser('admin1', 'admin');
    admin2 = await platformUser('admin2', 'admin');
    inactive = await platformUser('inactive', 'admin', 'suspended');
    ordinary = await platformUser('ordinary', null);
  });

  afterAll(async () => {
    for (const c of extra) await c.end().catch(() => undefined);
    await admin?.query(`REVOKE customer_privacy_operator FROM ${OP}`).catch(() => undefined);
    await admin?.query(`DROP OWNED BY ${OP}`).catch(() => undefined);
    await admin?.query(`DROP ROLE IF EXISTS ${OP}`).catch(() => undefined);
    await admin?.query(`DROP OWNED BY ${APPLOGIN}`).catch(() => undefined);
    await admin?.query(`DROP ROLE IF EXISTS ${APPLOGIN}`).catch(() => undefined);
    await admin?.end();
    }, 60_000);

  describe('roles, ownership and the authorization boundary', () => {
    it('the two roles are NOLOGIN, safe and memberless; the 13 functions are definer, owned by the owner role, fixed search_path, EXECUTE only for the operator', async () => {
      const roles = await q(`SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname IN ('customer_privacy_owner','customer_privacy_operator') ORDER BY 1`);
      expect(roles).toHaveLength(2);
      for (const r of roles) expect([r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolbypassrls]).toEqual([false, false, false, false]);
      expect(await q(`SELECT m.member::regrole::text AS member FROM pg_auth_members m WHERE m.roleid = 'customer_privacy_owner'::regrole`)).toEqual([]);
      expect((await q(`SELECT m.member::regrole::text AS member FROM pg_auth_members m WHERE m.roleid = 'customer_privacy_operator'::regrole`)).map((r) => r.member).filter((m) => !m.startsWith('d2rt_op_'))).toEqual([OP]); // only this test's own grant (the sibling isolation suite's transient operator login is ignored)
      const fns = await q(`SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, has_function_privilege('customer_privacy_operator', p.oid, 'EXECUTE') AS op_exec,
          has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('privacy_request_submit','privacy_request_advance','privacy_request_record_verification','privacy_request_approve','privacy_request_reject','legal_hold_place','legal_hold_release','privacy_anonymize_customer','retention_policy_register','retention_policy_approve','retention_policy_disable','retention_preview_onboarding_events','retention_execute_onboarding_events')`);
      expect(fns).toHaveLength(13);
      for (const f of fns) expect([f.prosecdef, f.owner, f.proconfig, f.op_exec, f.public_exec], f.proname).toEqual([true, 'customer_privacy_owner', ['search_path=pg_catalog, public'], true, false]);
    });

    it('an ordinary login holding EVERY table privilege cannot call any function (no EXECUTE), nor assume the owner/operator roles', async () => {
      const calls = [
        `SELECT public.privacy_request_submit(gen_random_uuid(), 'x', 'platform_assisted')`, `SELECT public.privacy_anonymize_customer(gen_random_uuid())`,
        `SELECT public.legal_hold_place(gen_random_uuid(), NULL, 'legal_proceeding', 'h', gen_random_uuid())`, `SELECT public.retention_preview_onboarding_events(30)`,
        `SELECT public.retention_execute_onboarding_events(gen_random_uuid(), 1)`, `SELECT public.retention_policy_register('customer_onboarding_events', 1, 30, false)`,
      ];
      await asAppLogin(async (c) => {
        for (const s of calls) expect(await msg(c.query(s)), s).toMatch(/permission denied for function/i);
        for (const r of ['customer_privacy_owner', 'customer_privacy_operator']) expect(await msg(c.query(`SET ROLE ${r}`)), r).toMatch(/permission denied to set role/i);
      });
    });

    it('even with every table privilege, direct writes to the workflow tables are refused by the database (state machine and append-only guards)', async () => {
      const cust = await customer(false);
      // rows must exist, or a row-level DELETE/UPDATE trigger would never fire and the test would prove nothing
      const seed = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [cust.id, `seed-${run}-${++seq}`]))[0].id as string;
      await call(`SELECT public.legal_hold_place($1, NULL, 'legal_proceeding', $2, $3)`, [cust.id, `seedhold-${run}-${seq}`, admin1]);
      await call(`SELECT public.retention_policy_register('customer_onboarding_events', $1, NULL, false)`, [freshVersion()]);
      await call(`SELECT * FROM public.retention_preview_onboarding_events(365)`);
      expect(seed).toBeTruthy();
      await asAppLogin(async (c) => {
        expect(await msg(c.query(`INSERT INTO privacy_requests (request_ref, customer_id, channel, state) VALUES ($1, $2, 'platform_assisted', 'approved')`, [`forge-${run}`, cust.id]))).toMatch(/PRIVACY_REQUEST_MUST_START_SUBMITTED/);
        for (const s of [`DELETE FROM privacy_requests`, `TRUNCATE privacy_requests`, `UPDATE privacy_request_transitions SET to_state = 'x'`, `DELETE FROM privacy_request_transitions`, `TRUNCATE privacy_request_transitions`,
          `DELETE FROM legal_holds`, `TRUNCATE legal_holds`, `DELETE FROM retention_policies`, `TRUNCATE retention_policies`, `UPDATE retention_runs SET mode = 'dry_run'`, `DELETE FROM retention_runs`, `TRUNCATE retention_runs`]) {
          expect(await msg(c.query(s)), s).toMatch(/PRIVACY_[A-Z_]+|RETENTION|permission denied|cannot truncate/i);
        }
        const id = (await q(`INSERT INTO privacy_requests (request_ref, customer_id, channel) VALUES ($1, $2, 'platform_assisted') RETURNING id`, [`ok-${run}-${++seq}`, cust.id]))[0].id;
        expect(await msg(c.query(`UPDATE privacy_requests SET state = 'approved' WHERE id = $1`, [id]))).toMatch(/PRIVACY_REQUEST_RESTRICTED/);
        expect(await msg(c.query(`UPDATE customers SET anonymized_at = now(), phone = NULL, full_name = NULL, email = NULL, birthday = NULL, phone_verified_at = NULL, preferred_locale = NULL WHERE id = $1`, [cust.id]))).toMatch(/CUSTOMER_ANONYMIZATION_RESTRICTED/);
      });
      expect((await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [cust.id]))[0].anonymized_at).toBeNull();
    });

    it('TRUNCATE is denied on every table 0086 guards (customers, memberships, credentials, sessions), directly and through a parent CASCADE, and the guards are ENABLE ALWAYS', async () => {
      for (const t of ['customers', 'business_customer_memberships', 'customer_credentials', 'customer_sessions']) {
        const trg = await q(`SELECT tgenabled FROM pg_trigger WHERE tgrelid = $1::regclass AND tgname = $2`, [`public.${t}`, `${t}_no_truncate`]);
        expect(trg.map((r) => r.tgenabled), t).toEqual(['A']);
      }
      expect(await msg(admin.query(`TRUNCATE customers CASCADE`))).toMatch(/TRUNCATE_DENIED/);
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL session_replication_role = replica`);
        expect(await msg(admin.query(`TRUNCATE customer_sessions, customer_refresh_tokens`))).toMatch(/CUSTOMER_IDENTITY_TRUNCATE_DENIED/); // with its referencing table listed, only the trigger can deny it
      } finally { await admin.query('ROLLBACK'); }
    });

    it('the superuser test connection is refused too (the guards trust current_user, not privilege), triggers are ENABLE ALWAYS and replica role does not skip them', async () => {
      const t = await q(`SELECT tgrelid::regclass::text AS tbl, tgname, tgenabled FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
        ('customer_anonymization_guard_trg','privacy_request_guard_trg','privacy_requests_no_truncate','privacy_request_transitions_guard_trg','privacy_request_transitions_no_truncate','retention_runs_guard_trg','retention_runs_no_truncate','legal_holds_guard_trg','legal_holds_no_truncate','retention_policies_guard_trg','retention_policies_no_truncate','customer_not_anonymized_guard_trg')`);
      expect(t.length).toBeGreaterThanOrEqual(14);
      for (const r of t) expect(r.tgenabled, `${r.tbl}.${r.tgname}`).toBe('A');
      const cust = await customer(false);
      const id = (await q(`INSERT INTO privacy_requests (request_ref, customer_id, channel) VALUES ($1, $2, 'platform_assisted') RETURNING id`, [`su-${run}-${++seq}`, cust.id]))[0].id;
      await admin.query(`SET session_replication_role = replica`);
      try {
        expect(await msg(admin.query(`UPDATE privacy_requests SET state = 'approved' WHERE id = $1`, [id]))).toMatch(/PRIVACY_REQUEST_RESTRICTED/);
        expect(await msg(admin.query(`DELETE FROM privacy_requests WHERE id = $1`, [id]))).toMatch(/PRIVACY_REQUEST_APPEND_ONLY/);
      } finally { await admin.query(`RESET session_replication_role`); }
    });
  });

  describe('the request workflow (state machine, authorization, replay protection)', () => {
    it('walks every state in order, records each transition with the DB identity and the platform actor, and completes', async () => {
      const w = await world('flow');
      const c = await customer();
      await join(w, c.id);
      const id = await approved(c.id);
      const out = await anonymize(id);
      expect(out.out_outcome).toBe('completed');
      const trail = await q(`SELECT from_state, to_state, actor_role FROM privacy_request_transitions WHERE request_id = $1 ORDER BY seq`, [id]);
      expect(trail.map((t) => `${t.from_state ?? '-'}>${t.to_state}`)).toEqual([
        '->submitted', 'submitted>identity_verification_required', 'identity_verification_required>identity_verified', 'identity_verified>scope_assessment',
        'scope_assessment>retention_assessment', 'retention_assessment>approved', 'approved>processing', 'processing>completed']);
      const sessionUser = (await q(`SELECT session_user AS u`))[0].u as string;
      expect(trail.every((t) => t.actor_role === sessionUser)).toBe(true); // session_user of the connection that really ran it, never a caller-supplied name (the test connection runs SET ROLE, so session_user is the login)
      const r = await reqRow(id);
      expect([r.state, r.decision_code, r.verification_method]).toEqual(['completed', 'approved', 'out_of_band_platform_verified']);
    });

    it('an unverified, unapproved or forged request can NEVER start anonymization: every pre-approval state refuses, and the customer is untouched', async () => {
      const w = await world('forged');
      const c = await customer();
      await join(w, c.id);
      const before = JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0]);
      const id = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [c.id, `fg-${run}-${++seq}`]))[0].id as string;
      const attempt = async (label: string) => {
        expect(await msg(anonymize(id)), label).toMatch(/PRIVACY_REQUEST_NOT_APPROVED/);
        expect(JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0]), `${label}: customer changed`).toBe(before);
      };
      await attempt('submitted');
      await call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, support]);
      await attempt('identity_verification_required');
      await call(`SELECT public.privacy_request_record_verification($1, 'out_of_band_platform_verified', $2, $3)`, [id, `ev-${run}-${++seq}`, support]);
      await attempt('identity_verified');
      await call(`SELECT public.privacy_request_advance($1, 'scope_assessment', $2)`, [id, support]);
      await attempt('scope_assessment');
      await call(`SELECT public.privacy_request_advance($1, 'retention_assessment', $2)`, [id, support]);
      await attempt('retention_assessment');
      // a forged shortcut: forcing the state directly is refused for every role, including the superuser test connection
      expect(await msg(admin.query(`UPDATE privacy_requests SET state = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [id, admin1]))).toMatch(/PRIVACY_REQUEST_RESTRICTED/);
      // a rejected request is terminal and can never be processed
      const rej = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [c.id, `fg2-${run}-${++seq}`]))[0].id as string;
      await call(`SELECT public.privacy_request_reject($1, $2, 'rejected_unverified')`, [rej, support]);
      expect(await msg(anonymize(rej))).toMatch(/PRIVACY_REQUEST_NOT_APPROVED/);
      expect((await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [c.id]))[0].anonymized_at).toBeNull();
    });

    it('refuses skipped, backward and terminal transitions, and the dedicated-function states via the generic advance', async () => {
      const c = await customer(false);
      const id = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [c.id, `st-${run}-${++seq}`]))[0].id as string;
      expect(await msg(call(`SELECT public.privacy_request_advance($1, 'scope_assessment', $2)`, [id, support]))).toMatch(/PRIVACY_REQUEST_TRANSITION_INVALID/);
      expect(await msg(call(`SELECT public.privacy_request_advance($1, 'approved', $2)`, [id, support]))).toMatch(/USE_DEDICATED_FUNCTION/);
      expect(await msg(call(`SELECT public.privacy_request_advance($1, 'completed', $2)`, [id, support]))).toMatch(/USE_DEDICATED_FUNCTION/);
      expect(await msg(call(`SELECT public.privacy_request_approve($1, $2, 'x')`, [id, admin1]))).toMatch(/PRIVACY_REQUEST_STATE_INVALID/);
      expect(await msg(anonymize(id))).toMatch(/PRIVACY_REQUEST_NOT_APPROVED/);
      await call(`SELECT public.privacy_request_reject($1, $2, 'rejected_duplicate')`, [id, support]);
      expect(await msg(call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, support]))).toMatch(/PRIVACY_REQUEST_TRANSITION_INVALID|TERMINAL/);
      expect((await reqRow(id)).state).toBe('rejected');
    });

    it('only an active platform user of the right role may act; approval needs an ADMIN other than the verifier (separation of duties)', async () => {
      const c = await customer(false);
      const id = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [c.id, `au-${run}-${++seq}`]))[0].id as string;
      for (const actor of [ordinary, inactive, randomUUID()]) expect(await msg(call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, actor]))).toMatch(/PRIVACY_ACTOR_NOT_AUTHORIZED/);
      await call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, support]);
      await call(`SELECT public.privacy_request_record_verification($1, 'out_of_band_platform_verified', $2, $3)`, [id, `ev-${run}-${++seq}`, admin1]);
      await call(`SELECT public.privacy_request_advance($1, 'scope_assessment', $2)`, [id, support]);
      await call(`SELECT public.privacy_request_advance($1, 'retention_assessment', $2)`, [id, support]);
      expect(await msg(call(`SELECT public.privacy_request_approve($1, $2, 'x')`, [id, support]))).toMatch(/PRIVACY_ACTOR_NOT_AUTHORIZED/); // support cannot approve
      expect(await msg(call(`SELECT public.privacy_request_approve($1, $2, 'x')`, [id, admin1]))).toMatch(/PRIVACY_ACTOR_NOT_AUTHORIZED/); // the verifier cannot approve their own verification
      expect(await msg(call(`SELECT public.privacy_request_approve($1, $2, 'x')`, [id, inactive]))).toMatch(/PRIVACY_ACTOR_NOT_AUTHORIZED/);
      await call(`SELECT public.privacy_request_approve($1, $2, 'x')`, [id, admin2]);
      expect((await reqRow(id)).approved_by).toBe(admin2);
    });

    it('a customer-authenticated request needs the re-authentication method; unknown methods and malformed references are refused', async () => {
      const c = await customer(false);
      const id = (await call(`SELECT public.privacy_request_submit($1, $2, 'customer_authenticated') AS id`, [c.id, `ch-${run}-${++seq}`]))[0].id as string;
      await call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, support]);
      expect(await msg(call(`SELECT public.privacy_request_record_verification($1, 'out_of_band_platform_verified', $2, $3)`, [id, `ev-${run}-${++seq}`, support]))).toMatch(/METHOD_MISMATCH/);
      expect(await msg(call(`SELECT public.privacy_request_record_verification($1, 'telepathy', $2, $3)`, [id, `ev-${run}-${++seq}`, support]))).toMatch(/ARGUMENT_INVALID/);
      expect(await msg(call(`SELECT public.privacy_request_record_verification($1, 'customer_reauthentication', 'bad ref!', $2)`, [id, support]))).toMatch(/ARGUMENT_INVALID/);
      expect(await msg(call(`SELECT public.privacy_request_submit($1, 'has space', 'platform_assisted')`, [c.id]))).toMatch(/ARGUMENT_INVALID/);
      expect(await msg(call(`SELECT public.privacy_request_submit($1, 'ok-ref', 'carrier_pigeon')`, [c.id]))).toMatch(/ARGUMENT_INVALID/);
    });

    it('replay protection: the same submission is idempotent, a reused reference for another customer conflicts, and one verification proof can verify only one request', async () => {
      const a = await customer(false);
      const b = await customer(false);
      const ref = `rp-${run}-${++seq}`;
      const first = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [a.id, ref]))[0].id;
      expect((await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [a.id, ref]))[0].id).toBe(first);
      expect(await msg(call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted')`, [b.id, ref]))).toMatch(/PRIVACY_REQUEST_REF_CONFLICT/);
      expect((await q(`SELECT count(*)::int AS n FROM privacy_requests WHERE request_ref = $1`, [ref]))[0].n).toBe(1);
      const idB = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [b.id, `rp2-${run}-${seq}`]))[0].id as string;
      const proof = `proof-${run}-${++seq}`;
      await call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [first, support]);
      await call(`SELECT public.privacy_request_record_verification($1, 'out_of_band_platform_verified', $2, $3)`, [first, proof, support]);
      await call(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [idB, support]);
      expect(await msg(call(`SELECT public.privacy_request_record_verification($1, 'out_of_band_platform_verified', $2, $3)`, [idB, proof, support]))).toMatch(/duplicate key|privacy_requests_evidence_ref_unique/);
    });

    it('verification cannot be rewritten once recorded, and an unverified request can never be approved', async () => {
      const c = await customer(false);
      const id = await toRetentionAssessment(c.id);
      expect(await msg(admin.query(`UPDATE privacy_requests SET verified_at = NULL WHERE id = $1`, [id]))).toMatch(/PRIVACY_REQUEST_RESTRICTED|VERIFIED/); // superuser refused
      const d = await customer(false);
      const raw = (await call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [d.id, `uv-${run}-${++seq}`]))[0].id as string;
      expect(await msg(call(`SELECT public.privacy_request_approve($1, $2, 'x')`, [raw, admin1]))).toMatch(/STATE_INVALID/);
    });
  });

  describe('customer shell anonymization', () => {
    const fixtureRows = async (w: World, c: { id: string; phone: string; email: string }) => {
      await q(`INSERT INTO customer_credentials (customer_id, password_hash, password_set_at, password_changed_at, login_email, login_email_verified_at) VALUES ($1, 'h', now(), now(), $2, now())`, [c.id, c.email]);
      const s = (await q(`INSERT INTO customer_sessions (customer_id, auth_method, absolute_expires_at, idle_expires_at, device_label) VALUES ($1, 'otp', now() + interval '1 day', now() + interval '1 hour', 'Pixel 9') RETURNING id`, [c.id]))[0].id;
      await q(`INSERT INTO customer_refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [s, randomBytes(32).toString('hex')]);
      await q(`INSERT INTO notifications (business_id, customer_id, event_type, channel, recipient_address, body) VALUES ($1, $2, 'points_earned', 'sms', $3, 'You earned points')`, [w.biz, c.id, c.phone]);
      await q(`INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, 'c', now() + interval '5 minutes')`, [c.phone]);
      await q(`INSERT INTO otp_request_cooldowns (phone, requested_at) VALUES ($1, now()) ON CONFLICT DO NOTHING`, [c.phone]);
      const fx = await connect();
      await fx.query(`SET session_replication_role = replica`); // fixture only: the feedback row's branch/QR parents are not needed for what is being tested
      await fx.query(`INSERT INTO feedback (business_id, branch_id, qr_code_id, rating, customer_name, customer_email, customer_phone, comment) VALUES ($1, $2, gen_random_uuid(), 4, 'Real Name', $3, $4, 'Great service')`, [w.biz, w.b1, c.email, c.phone]);
      const conv = (await q(`INSERT INTO conversations (customer_id, business_id) VALUES ($1, $2) RETURNING id`, [c.id, w.biz]))[0].id;
      await q(`INSERT INTO messages (conversation_id, sender_type, sender_id, body) VALUES ($1, 'customer', $2, 'hello')`, [conv, c.id]);
    };

    it('removes the direct identifiers irreversibly and deletes authentication, recovery, notification and OTP data, with exact counts; flags control the policy-dependent items', async () => {
      const w = await world('anon');
      const c = await customer();
      await join(w, c.id);
      await fixtureRows(w, c);
      const id = await approved(c.id, { feedback: false, conv: false });
      const out = await anonymize(id);
      expect(out).toMatchObject({ out_outcome: 'completed', out_events_severed: 1, out_sessions_deleted: 1, out_credentials_deleted: 1, out_notifications_deleted: 1, out_otp_deleted: 2, out_feedback_scrubbed: 0, out_conversations_deleted: 0 });
      const shell = (await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0];
      expect([shell.phone, shell.full_name, shell.email, shell.birthday, shell.phone_verified_at, shell.preferred_locale]).toEqual([null, null, null, null, null, null]);
      expect(shell.anonymized_at).not.toBeNull();
      expect(shell.qr_revocation_epoch).toBeGreaterThan(0); // issued QR tokens are invalidated
      for (const t of ['customer_sessions', 'customer_credentials', 'notifications']) expect((await q(`SELECT count(*)::int AS n FROM ${t} WHERE customer_id = $1`, [c.id]))[0].n, t).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM customer_refresh_tokens r WHERE NOT EXISTS (SELECT 1 FROM customer_sessions s WHERE s.id = r.session_id)`))[0].n).toBe(0);
      // policy-dependent items are untouched unless the approver chose them
      expect((await q(`SELECT customer_phone, customer_email FROM feedback WHERE business_id = $1`, [w.biz]))[0]).toEqual({ customer_phone: c.phone, customer_email: c.email });
      expect((await q(`SELECT count(*)::int AS n FROM conversations WHERE customer_id = $1`, [c.id]))[0].n).toBe(1);
    });

    it('with the feedback and conversation options chosen, contact details are scrubbed (feedback text and rating stay) and conversations are deleted', async () => {
      const w = await world('anon2');
      const c = await customer();
      await join(w, c.id);
      await fixtureRows(w, c);
      const out = await anonymize(await approved(c.id, { feedback: true, conv: true }));
      expect(out).toMatchObject({ out_feedback_scrubbed: 1, out_conversations_deleted: 1 });
      expect((await q(`SELECT customer_name, customer_email, customer_phone, comment, rating FROM feedback WHERE business_id = $1`, [w.biz]))[0]).toEqual({ customer_name: null, customer_email: null, customer_phone: null, comment: 'Great service', rating: 4 });
      expect((await q(`SELECT count(*)::int AS n FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)`))[0].n).toBe(0);
    });

    it('keeps the memberships, consent grants, loyalty accounts and sanctions (financial/consent/security records) and touches no other customer', async () => {
      const w = await world('keep');
      const c = await customer();
      const other = await customer();
      await join(w, c.id);
      await join(w, other.id);
      await q(`INSERT INTO customer_sanctions (customer_id, business_id, action, reason) VALUES ($1, $2, 'warning', 'test fixture')`, [c.id, w.biz]).catch(() => q(`INSERT INTO customer_sanctions (customer_id, action, reason) VALUES ($1, 'warning', 'test fixture')`, [c.id]));
      const count = async (t: string, id: string) => (await q(`SELECT count(*)::int AS n FROM ${t} WHERE customer_id = $1`, [id]))[0].n as number;
      const before = { m: await count('business_customer_memberships', c.id), cg: await count('consent_grants', c.id), la: await count('loyalty_accounts', c.id), cs: await count('customer_sanctions', c.id) };
      const otherBefore = JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [other.id]))[0]);
      await anonymize(await approved(c.id));
      expect({ m: await count('business_customer_memberships', c.id), cg: await count('consent_grants', c.id), la: await count('loyalty_accounts', c.id), cs: await count('customer_sanctions', c.id) }).toEqual(before);
      expect(JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [other.id]))[0])).toBe(otherBefore);
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 AND customer_id = $2`, [w.biz, other.id]))[0].n).toBe(1); // the bystander's event stays linked
    });

    it('severs the onboarding events of EVERY business the customer joined (cross-business), not just one', async () => {
      const w1 = await world('xb1');
      const w2 = await world('xb2');
      const c = await customer();
      await join(w1, c.id);
      await q(`UPDATE customers SET phone_verified_at = now() WHERE id = $1`, [c.id]);
      await join(w2, c.id);
      const out = await anonymize(await approved(c.id));
      expect(out.out_events_severed).toBe(2);
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1`, [c.id]))[0].n).toBe(0);
    });

    it('is idempotent: re-running a completed request is a no-op with the recorded counts, and nothing changes', async () => {
      const w = await world('idem');
      const c = await customer();
      await join(w, c.id);
      const id = await approved(c.id);
      const first = await anonymize(id);
      const snapshot = JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0]);
      const again = await anonymize(id);
      expect(again.out_outcome).toBe('noop');
      expect(again.out_events_severed).toBe(first.out_events_severed);
      expect(JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0])).toBe(snapshot);
      expect((await q(`SELECT count(*)::int AS n FROM privacy_request_transitions WHERE request_id = $1 AND to_state = 'completed'`, [id]))[0].n).toBe(1);
    });

    it('an anonymized customer cannot gain a membership, credential or session, cannot be re-anonymized or have the shell altered, and cannot file another request', async () => {
      const w = await world('after');
      const c = await customer();
      await anonymize(await approved(c.id));
      expect(await msg(join(w, c.id))).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      expect(await msg(q(`INSERT INTO customer_sessions (customer_id, auth_method, absolute_expires_at, idle_expires_at) VALUES ($1, 'otp', now() + interval '1 day', now() + interval '1 hour')`, [c.id]))).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      expect(await msg(q(`INSERT INTO customer_credentials (customer_id, password_hash, password_set_at, password_changed_at) VALUES ($1, 'h', now(), now())`, [c.id]))).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      expect(await msg(q(`UPDATE customers SET anonymized_at = NULL WHERE id = $1`, [c.id]))).toMatch(/CUSTOMER_ANONYMIZATION_IRREVERSIBLE/);
      expect(await msg(q(`UPDATE customers SET phone = '+15550000000' WHERE id = $1`, [c.id]))).toMatch(/customers_anonymized_shape_check/); // identifiers cannot be put back
      expect(await msg(call(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted')`, [c.id, `after-${run}-${++seq}`]))).toMatch(/ALREADY_ANONYMIZED/);
    });
  });

  describe('legal holds and atomicity', () => {
    it('an active hold turns the request into a recorded restriction: nothing is changed, the request FAILS with LEGAL_HOLD_ACTIVE, and a retry after release completes it', async () => {
      const w = await world('hold');
      const c = await customer();
      await join(w, c.id);
      const hold = (await call(`SELECT public.legal_hold_place($1, NULL, 'legal_proceeding', $2, $3) AS id`, [c.id, `hold-${run}-${++seq}`, admin1]))[0].id as string;
      const id = await approved(c.id);
      const before = JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0]);
      const out = await anonymize(id);
      expect(out.out_outcome).toBe('restricted');
      const r = await reqRow(id);
      expect([r.state, r.failure_code]).toEqual(['failed', 'LEGAL_HOLD_ACTIVE']);
      expect(JSON.stringify((await q(`SELECT * FROM customers WHERE id = $1`, [c.id]))[0])).toBe(before);
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1 AND erased_at IS NULL`, [c.id]))[0].n).toBe(1);
      expect((await call(`SELECT public.legal_hold_release($1, $2) AS ok`, [hold, admin2]))[0].ok).toBe(true);
      expect((await call(`SELECT public.legal_hold_release($1, $2) AS ok`, [hold, admin2]))[0].ok).toBe(false); // releasing again is a no-op
      expect((await anonymize(id)).out_outcome).toBe('completed'); // failed -> processing retry is allowed
      expect((await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [c.id]))[0].anonymized_at).not.toBeNull();
    });

    it('holds are admin-only, idempotent by reference, never deletable, and releasable once', async () => {
      const c = await customer(false);
      const ref = `hold-${run}-${++seq}`;
      expect(await msg(call(`SELECT public.legal_hold_place($1, NULL, 'legal_proceeding', $2, $3)`, [c.id, ref, support]))).toMatch(/PRIVACY_ACTOR_NOT_AUTHORIZED/);
      const id = (await call(`SELECT public.legal_hold_place($1, NULL, 'fraud_investigation', $2, $3) AS id`, [c.id, ref, admin1]))[0].id;
      expect((await call(`SELECT public.legal_hold_place($1, NULL, 'fraud_investigation', $2, $3) AS id`, [c.id, ref, admin1]))[0].id).toBe(id);
      expect(await msg(call(`SELECT public.legal_hold_place($1, NULL, 'legal_proceeding', $2, $3)`, [c.id, ref, admin1]))).toMatch(/LEGAL_HOLD_REF_CONFLICT/); // same reference, different reason: refused, never silently merged
      expect(await msg(call(`SELECT public.legal_hold_place($1, NULL, 'not_a_reason', 'zz', $2)`, [c.id, admin1]))).toMatch(/ARGUMENT_INVALID/);
      expect(await msg(admin.query(`DELETE FROM legal_holds WHERE id = $1`, [id]))).toMatch(/PRIVACY_REGISTRY_NO_DELETE/);
    });

    it('a failure in the middle rolls EVERYTHING back (state stays approved, the customer is untouched), and a retry then succeeds', async () => {
      const w = await world('atomic');
      const c = await customer();
      await join(w, c.id);
      await q(`INSERT INTO notifications (business_id, customer_id, event_type, channel, recipient_address, body) VALUES ($1, $2, 'points_earned', 'sms', $3, 'x')`, [w.biz, c.id, c.phone]);
      const id = await approved(c.id);
      await q(`CREATE OR REPLACE FUNCTION public.d2f_boom_${run}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'D2F_INJECTED_FAILURE'; END $f$`);
      await q(`CREATE TRIGGER d2f_boom_trg BEFORE DELETE ON notifications FOR EACH ROW EXECUTE FUNCTION public.d2f_boom_${run}()`);
      try {
        expect(await msg(anonymize(id))).toMatch(/D2F_INJECTED_FAILURE/);
      } finally {
        await q(`DROP TRIGGER d2f_boom_trg ON notifications`);
        await q(`DROP FUNCTION public.d2f_boom_${run}()`);
      }
      expect((await reqRow(id)).state).toBe('approved');
      expect((await q(`SELECT phone, anonymized_at FROM customers WHERE id = $1`, [c.id]))[0]).toEqual({ phone: c.phone, anonymized_at: null });
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1 AND erased_at IS NULL`, [c.id]))[0].n).toBe(1);
      expect((await anonymize(id)).out_outcome).toBe('completed');
    });
  });

  describe('identity linkage after anonymization (the audit paths)', () => {
    it('BOTH historic re-identification paths now lead only to an identity-free shell: audit membershipId -> membership -> customer, and exact audit time -> membership.joined_at -> customer', async () => {
      const w = await world('linkage');
      const c = await customer();
      const { membership } = await join(w, c.id);
      const ev = (await q(`SELECT id FROM customer_onboarding_events WHERE business_id = $1`, [w.biz]))[0].id as string;
      const historic = (await q(`INSERT INTO audit_log (business_id, action, entity_type, entity_id, metadata) VALUES ($1, 'customer.onboarded', 'customer_onboarding_event', $2, $3::jsonb) RETURNING id`,
        [w.biz, ev, JSON.stringify({ source: 'business_qr', membershipId: membership.id })]))[0].id as string;
      await anonymize(await approved(c.id));
      // path A (historical-shaped row): audit -> membership -> customer row: the row exists but holds no identifier
      const a = (await q(`SELECT c.* FROM audit_log al JOIN business_customer_memberships m ON m.id = (al.metadata ->> 'membershipId')::uuid JOIN customers c ON c.id = m.customer_id WHERE al.id = $1`, [historic]))[0];
      expect([a.phone, a.email, a.full_name, a.birthday]).toEqual([null, null, null, null]);
      // path B: exact time -> the single membership joined at that moment -> the same identity-free shell
      const b = (await q(`SELECT c.* FROM audit_log al JOIN business_customer_memberships m ON m.business_id = al.business_id AND abs(extract(epoch FROM (m.joined_at - al.created_at))) < 1 JOIN customers c ON c.id = m.customer_id WHERE al.entity_id = $1 AND al.id <> $2`, [ev, historic]))[0];
      if (b) expect([b.phone, b.email, b.full_name, b.birthday]).toEqual([null, null, null, null]);
    });

    it('SWEEP: after a full anonymization (with the policy options chosen) no text or jsonb column in any table still contains the customer\'s phone or email', async () => {
      const w = await world('sweep');
      const c = await customer();
      await join(w, c.id);
      await fixtureRowsForSweep(w, c);
      await anonymize(await approved(c.id, { feedback: true, conv: true }));
      const cols = await q(`SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c JOIN pg_tables t ON t.tablename = c.table_name AND t.schemaname = 'public'
         WHERE c.table_schema = 'public' AND c.data_type IN ('text', 'character varying', 'jsonb') AND c.table_name NOT LIKE 'drizzle%' ORDER BY 1, 2`);
      const leaks: string[] = [];
      for (const col of cols) {
        const expr = col.data_type === 'jsonb' ? `"${col.column_name}"::text` : `"${col.column_name}"`;
        const n = (await q(`SELECT count(*)::int AS n FROM public."${col.table_name}" WHERE ${expr} LIKE $1 OR ${expr} LIKE $2`, [`%${c.phone}%`, `%${c.email}%`]))[0].n as number;
        if (n > 0) leaks.push(`${col.table_name}.${col.column_name}=${n}`);
      }
      expect(leaks).toEqual([]);
    });
  });

  describe('concurrency', () => {
    it('six concurrent anonymizations of one request do the work exactly once; the others see a completed request', async () => {
      const w = await world('conc1');
      const c = await customer();
      await join(w, c.id);
      const id = await approved(c.id);
      const results = await Promise.all(Array.from({ length: 6 }, () => anonymize(id)));
      expect(results.filter((r) => r.out_outcome === 'completed')).toHaveLength(1);
      expect(results.filter((r) => r.out_outcome === 'noop')).toHaveLength(5);
      expect((await q(`SELECT count(*)::int AS n FROM privacy_request_transitions WHERE request_id = $1 AND to_state = 'completed'`, [id]))[0].n).toBe(1);
    });

    it('a join racing the anonymization either finishes first (and is then severed) or is refused afterwards: an anonymized customer never ends with a live session or an unsevered event', async () => {
      for (let round = 0; round < 6; round++) {
        const w1 = await world(`race1-${round}`);
        const w2 = await world(`race2-${round}`);
        const c = await customer();
        await join(w1, c.id);
        await q(`UPDATE customers SET phone_verified_at = now() WHERE id = $1`, [c.id]);
        const id = await approved(c.id);
        const [, joined] = await Promise.allSettled([anonymize(id), join(w2, c.id)]);
        const shell = (await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [c.id]))[0];
        expect(shell.anonymized_at, `round ${round}`).not.toBeNull();
        expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1 AND erased_at IS NULL`, [c.id]))[0].n, `round ${round} unsevered`).toBe(0);
        if (joined.status === 'rejected') {
          // The service can refuse before SQL, or PostgreSQL can refuse in its
          // terminal-identity trigger. Drizzle wraps the latter in `cause`;
          // neither path may be replaced by a generic database failure.
          const error = joined.reason as Error & { cause?: Error };
          expect(`${error.message} ${error.cause?.message ?? ''}`).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
        }
        else expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 AND customer_id IS NULL`, [w2.biz]))[0].n).toBe(1); // the racing join was severed too
      }
    });

    it('deterministically refuses a join paused after eligibility reads until anonymization commits (including the wrapped database cause)', async () => {
      const w1 = await world('barrier-old');
      const w2 = await world('barrier-new');
      const c = await customer();
      await join(w1, c.id);
      const id = await approved(c.id);
      const key = `d2f_insert_barrier:${run}`;
      const trigger = `aaa_d2f_insert_barrier_${run}`;
      const fn = `d2f_insert_barrier_${run}`;
      const holder = await connect();
      const joiningClient = await connect();
      const joiningService = new CustomerMembershipService(appDbOf(buildDb(joiningClient)));
      // Test-only trigger, restricted to this synthetic customer/business.
      // Alphabetic order puts the barrier BEFORE the existing terminal guard.
      // Never disable/replace a production guard or change a migration.
      await q(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.customer_id = '${c.id}'::uuid AND NEW.business_id = '${w2.biz}'::uuid THEN
            PERFORM pg_advisory_xact_lock(hashtextextended('${key}', 0));
          END IF;
          RETURN NEW;
        END $$`);
      let pending: Promise<PromiseSettledResult<unknown>> | undefined;
      try {
        await q(`CREATE TRIGGER ${trigger} BEFORE INSERT ON public.business_customer_memberships FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
        pending = join(w2, c.id, joiningService).then(
          (value): PromiseFulfilledResult<unknown> => ({ status: 'fulfilled', value }),
          (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
        );
        // Wait for an observed database lock, not an arbitrary timing sleep.
        const deadline = Date.now() + 5_000;
        let waiting = 0;
        do {
          waiting = Number((await q(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [key]))[0].n);
        } while (waiting === 0 && Date.now() < deadline);
        expect(waiting, 'the actual membership INSERT must wait at the test barrier').toBe(1);
        expect((await q('SELECT anonymized_at FROM customers WHERE id = $1', [c.id]))[0].anonymized_at).toBeNull();
        expect((await anonymize(id)).out_outcome).toBe('completed');
        await holder.query('COMMIT');
        const result = await pending;
        expect(result.status).toBe('rejected');
        if (result.status !== 'rejected') throw new Error('The terminal identity guard did not reject the paused Join.');
        const error = result.reason as Error & { cause?: Error & { code?: string } };
        expect(error.message).toContain('Failed query:');
        expect(error.cause?.message).toContain('CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY');
        expect(error.cause?.code).toBe('23000');
        expect((await q('SELECT anonymized_at FROM customers WHERE id = $1', [c.id]))[0].anonymized_at).not.toBeNull();
        for (const table of ['business_customer_memberships', 'loyalty_accounts', 'consent_grants', 'customer_onboarding_events']) {
          expect((await q(`SELECT count(*)::int AS n FROM ${table} WHERE customer_id = $1 AND business_id = $2`, [c.id, w2.biz]))[0].n, table).toBe(0);
        }
        expect((await q('SELECT count(*)::int AS n FROM customer_sessions WHERE customer_id = $1', [c.id]))[0].n).toBe(0);
        expect((await q('SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1 AND erased_at IS NULL', [c.id]))[0].n).toBe(0);
      } finally {
        await holder.query('ROLLBACK');
        await pending;
        await q(`DROP TRIGGER IF EXISTS ${trigger} ON public.business_customer_memberships`);
        await q(`DROP FUNCTION IF EXISTS public.${fn}()`);
        await holder.end();
        await joiningClient.end();
      }
    });

    it('the anonymization takes the SAME relationship advisory lock as join/leave/withdrawal: it waits behind an in-flight relationship transaction and proceeds when it commits (deterministic, no timing luck)', async () => {
      const w = await world('lockorder');
      const c = await customer();
      // a membership WITHOUT onboarding events: only the anonymization's own lock loop (not the nested 0084 function) can produce the wait
      await q(`INSERT INTO business_customer_memberships (customer_id, business_id, status) VALUES ($1, $2, 'active')`, [c.id, w.biz]);
      const id = await approved(c.id);
      const key = `customer_business_relationship:${c.id}:${w.biz}`;
      const holder = await connect();
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
      const pending = anonymize(id);
      let waiting = 0;
      for (let i = 0; i < 100 && waiting === 0; i++) {
        waiting = Number((await q(`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`, [key]))[0].n);
        if (waiting === 0) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, 'the anonymization must be blocked on the relationship advisory lock').toBe(1);
      expect((await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [c.id]))[0].anonymized_at).toBeNull(); // nothing happened while it waited
      await holder.query('COMMIT');
      expect((await pending).out_outcome).toBe('completed');
    });

    it('a REJOIN (membership reactivated by UPDATE, new event) racing the anonymization neither deadlocks nor leaves an unsevered event: the relationship-lock-first protocol holds', async () => {
      for (let round = 0; round < 8; round++) {
        const w = await world(`rejoin-${round}`);
        const c = await customer();
        await join(w, c.id);
        await service.leave(c.id, w.biz);
        const id = await approved(c.id);
        const [anon, again] = await Promise.allSettled([anonymize(id), join(w, c.id)]);
        expect(anon.status, `round ${round}: anonymization must not fail (a deadlock would show here): ${anon.status === 'rejected' ? String((anon.reason as Error).message) : ''}`).toBe('fulfilled');
        expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 AND customer_id IS NOT NULL`, [w.biz]))[0].n, `round ${round}: linked event left`).toBe(0);
        if (again.status === 'rejected') expect(String((again.reason as Error).message) + String((again.reason as { cause?: Error }).cause?.message ?? '')).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      }
    });

    it('concurrent loyalty ledger writes while a customer is anonymized: no deadlock, no lost write, the balance and every ledger row are preserved', async () => {
      for (let round = 0; round < 3; round++) {
        const w = await world(`loyalty-${round}`);
        const c = await customer();
        await join(w, c.id);
        const acct = (await q(`SELECT id FROM loyalty_accounts WHERE customer_id = $1 AND business_id = $2`, [c.id, w.biz]))[0].id as string;
        await q(`UPDATE loyalty_accounts SET points = 100 WHERE id = $1`, [acct]);
        await q(`INSERT INTO loyalty_transactions (loyalty_account_id, type, points) VALUES ($1, 'adjustment', 100)`, [acct]);
        const id = await approved(c.id);
        const writers = await Promise.all(Array.from({ length: 6 }, () => connect()));
        const work = writers.map(async (wc) => {
          for (let i = 0; i < 8; i++) {
            await wc.query('BEGIN');
            await wc.query(`INSERT INTO loyalty_transactions (loyalty_account_id, type, points) VALUES ($1, 'adjustment', 1)`, [acct]);
            await wc.query(`UPDATE loyalty_accounts SET points = points + 1 WHERE id = $1`, [acct]);
            await wc.query('COMMIT');
          }
        });
        const [anon, ...rest] = await Promise.allSettled([anonymize(id), ...work]);
        expect(anon.status, `round ${round}: ${anon.status === 'rejected' ? String((anon.reason as Error).message) : ''}`).toBe('fulfilled');
        for (const r of rest) expect(r.status, `round ${round} writer: ${r.status === 'rejected' ? String((r.reason as Error).message) : ''}`).toBe('fulfilled');
        expect((await q(`SELECT points FROM loyalty_accounts WHERE id = $1`, [acct]))[0].points, `round ${round}`).toBe(100 + 6 * 8);
        expect((await q(`SELECT coalesce(sum(points), 0)::int AS s, count(*)::int AS n FROM loyalty_transactions WHERE loyalty_account_id = $1`, [acct]))[0]).toEqual({ s: 100 + 6 * 8, n: 1 + 6 * 8 });
        expect((await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [c.id]))[0].anonymized_at).not.toBeNull();
      }
    });

    it('a legal hold racing the anonymization is never lost: either the hold wins (restricted, nothing changed) or the anonymization wins before the hold exists', async () => {
      for (let round = 0; round < 6; round++) {
        const c = await customer();
        const id = await approved(c.id);
        const [res, hold] = await Promise.allSettled([anonymize(id), call(`SELECT public.legal_hold_place($1, NULL, 'legal_proceeding', $2, $3) AS id`, [c.id, `race-${run}-${++seq}`, admin1])]);
        expect(hold.status, `round ${round}`).toBe('fulfilled');
        const anon = (await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [c.id]))[0].anonymized_at;
        const state = (await reqRow(id)).state;
        if (res.status === 'fulfilled' && (res.value as Record<string, unknown>).out_outcome === 'restricted') { expect([state, anon]).toEqual(['failed', null]); }
        else { expect([state, anon !== null]).toEqual(['completed', true]); }
      }
    });
  });

  describe('retention registry (policies disabled by default; nothing runs without an approval)', () => {
    const oldEvent = async (w: World, customerId: string, daysAgo: number) => {
      const membership = (await q(`SELECT id FROM business_customer_memberships WHERE customer_id = $1 AND business_id = $2`, [customerId, w.biz]))[0].id as string;
      const cashier = (await q(`INSERT INTO users (email, full_name, password_hash, status) VALUES ($1, 'C', 'x', 'active') RETURNING id`, [`d2f-ret-${run}-${++seq}@example.test`]))[0].id as string;
      void cashier;
      return (await q(`INSERT INTO customer_onboarding_events (membership_id, business_id, customer_id, branch_id, source, verification_state, reference, is_rejoin, occurred_at)
        VALUES ($1, $2, $3, $4, 'business_qr', 'unverified', $5, true, now() - make_interval(days => $6)) RETURNING id`, [membership, w.biz, customerId, w.b1, `qr-old-${run}-${++seq}`, daysAgo]))[0].id as string;
    };

    it('a registered policy is DISABLED and cannot be enabled by SQL without an approver, a period and a reference; content is immutable; deletion impossible', async () => {
      const pid = (await call(`SELECT public.retention_policy_register('customer_onboarding_events', $1, NULL, false) AS id`, [freshVersion()]))[0].id as string;
      expect((await q(`SELECT enabled, period_days, approved_by FROM retention_policies WHERE id = $1`, [pid]))[0]).toEqual({ enabled: false, period_days: null, approved_by: null });
      expect(await msg(call(`SELECT public.retention_policy_approve($1, $2, 'appr-1')`, [pid, admin1]))).toMatch(/retention_policies_enabled_requires_approval_check/); // no period set: cannot be enabled
      expect(await msg(admin.query(`UPDATE retention_policies SET enabled = true WHERE id = $1`, [pid]))).toMatch(/PRIVACY_REGISTRY_RESTRICTED/);
      expect(await msg(admin.query(`INSERT INTO retention_policies (category, version, enabled, period_days) VALUES ('customer_onboarding_events', 9999, true, 30)`))).toMatch(/RETENTION_POLICY_MUST_START_DISABLED/);
      expect(await msg(admin.query(`DELETE FROM retention_policies WHERE id = $1`, [pid]))).toMatch(/PRIVACY_REGISTRY_NO_DELETE/);
      expect(await msg(call(`SELECT public.retention_policy_register('anything_else', 1, 30, false)`))).toMatch(/ARGUMENT_INVALID/);
      expect(await msg(call(`SELECT public.retention_execute_onboarding_events($1, 10)`, [pid]))).toMatch(/RETENTION_POLICY_NOT_ENABLED/);
    });

    it('the dry-run preview deletes nothing, works while every policy is disabled, excludes legal holds, and is recorded', async () => {
      const w = await world('ret1');
      const a = await customer(); const b = await customer();
      await join(w, a.id); await join(w, b.id);
      await oldEvent(w, a.id, 800); await oldEvent(w, b.id, 800);
      await call(`SELECT public.legal_hold_place($1, $2, 'regulatory_inquiry', $3, $4)`, [b.id, w.biz, `ret-hold-${run}-${++seq}`, admin1]);
      const before = (await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE erased_at IS NULL`))[0].n;
      const prev = (await call(`SELECT * FROM public.retention_preview_onboarding_events(365)`))[0];
      expect(prev.out_candidate_pairs).toBeGreaterThanOrEqual(1);
      expect(prev.out_held_pairs).toBeGreaterThanOrEqual(1);
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE erased_at IS NULL`))[0].n).toBe(before);
      expect((await q(`SELECT mode, operator_role FROM retention_runs ORDER BY created_at DESC LIMIT 1`))[0]).toMatchObject({ mode: 'dry_run' });
      for (const bad of [0, -1, 40000]) expect(await msg(call(`SELECT * FROM public.retention_preview_onboarding_events($1)`, [bad]))).toMatch(/RETENTION_PERIOD_INVALID/);
    });

    it('two retention runs racing each other neither deadlock nor double-count, and every eligible pair ends erased', async () => {
      const w = await world('retrace');
      const people = await Promise.all([customer(), customer(), customer(), customer()]);
      for (const p of people) { await join(w, p.id); await q(`UPDATE customers SET phone_verified_at = now() WHERE id = $1`, [p.id]); }
      const evs = [] as string[];
      for (const p of people) evs.push(await oldEvent(w, p.id, 1200));
      const pid = (await call(`SELECT public.retention_policy_register('customer_onboarding_events', $1, 365, false) AS id`, [freshVersion()]))[0].id as string;
      await call(`SELECT public.retention_policy_approve($1, $2, $3)`, [pid, admin1, `race-${run}-${++seq}`]);
      const runs = await Promise.allSettled([call(`SELECT * FROM public.retention_execute_onboarding_events($1, 500)`, [pid]), call(`SELECT * FROM public.retention_execute_onboarding_events($1, 500)`, [pid])]);
      for (const r of runs) expect(r.status, r.status === 'rejected' ? String((r.reason as Error).message) : '').toBe('fulfilled');
      for (const r of runs) expect((r as PromiseFulfilledResult<Array<{ out_failed_pairs: number }>>).value[0]!.out_failed_pairs).toBe(0);
      for (const e of evs) expect((await q(`SELECT erased_at FROM customer_onboarding_events WHERE id = $1`, [e]))[0].erased_at).not.toBeNull();
    });

    it('a failure in ONE pair is isolated: the other pair is still erased, the failure is counted, the failed pair is untouched and is retried by the next run', async () => {
      const wA = await world('retfail-a');
      const wB = await world('retfail-b');
      const a = await customer(); const b = await customer();
      await join(wA, a.id); await join(wB, b.id);
      const evA = await oldEvent(wA, a.id, 1500); const evB = await oldEvent(wB, b.id, 1500);
      const pid = (await call(`SELECT public.retention_policy_register('customer_onboarding_events', $1, 365, false) AS id`, [freshVersion()]))[0].id as string;
      await call(`SELECT public.retention_policy_approve($1, $2, $3)`, [pid, admin1, `pf-${run}-${++seq}`]);
      await q(`CREATE OR REPLACE FUNCTION public.d2f_failpair_${run}() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN IF NEW.business_id = '${wA.biz}'::uuid THEN RAISE EXCEPTION 'D2F_INJECTED_PAIR_FAILURE'; END IF; RETURN NEW; END $f$`);
      await q(`CREATE TRIGGER d2f_failpair_trg BEFORE INSERT ON onboarding_erasure_operations FOR EACH ROW EXECUTE FUNCTION public.d2f_failpair_${run}()`);
      let first: Record<string, number>;
      try {
        first = (await call(`SELECT * FROM public.retention_execute_onboarding_events($1, 500)`, [pid]))[0] as Record<string, number>;
      } finally {
        await q(`DROP TRIGGER d2f_failpair_trg ON onboarding_erasure_operations`);
        await q(`DROP FUNCTION public.d2f_failpair_${run}()`);
      }
      expect(first.out_failed_pairs).toBe(1);
      expect((await q(`SELECT erased_at FROM customer_onboarding_events WHERE id = $1`, [evA]))[0].erased_at).toBeNull(); // the failed pair rolled back completely
      expect((await q(`SELECT customer_id FROM customer_onboarding_events WHERE id = $1`, [evA]))[0].customer_id).toBe(a.id);
      expect((await q(`SELECT erased_at FROM customer_onboarding_events WHERE id = $1`, [evB]))[0].erased_at).not.toBeNull(); // the other pair still ran
      const second = (await call(`SELECT * FROM public.retention_execute_onboarding_events($1, 500)`, [pid]))[0] as Record<string, number>;
      expect(second.out_failed_pairs).toBe(0);
      expect((await q(`SELECT erased_at FROM customer_onboarding_events WHERE id = $1`, [evA]))[0].erased_at).not.toBeNull(); // retried and completed
    });

    it('an approved FIXTURE policy erases only eligible, un-held pairs in bounded batches, is idempotent, records the run, and never touches recent events', async () => {
      const w = await world('ret2');
      const old = await customer(); const held = await customer(); const fresh = await customer();
      await join(w, old.id); await join(w, held.id); await join(w, fresh.id);
      const oldEv = await oldEvent(w, old.id, 900); await oldEvent(w, held.id, 900);
      await call(`SELECT public.legal_hold_place($1, NULL, 'financial_record_retention', $2, $3)`, [held.id, `ret2-hold-${run}-${++seq}`, admin1]);
      // the join events of these customers are "now"; only the 900-day events are eligible under a 365-day FIXTURE period (not a recommendation)
      const pid = (await call(`SELECT public.retention_policy_register('customer_onboarding_events', $1, 365, false) AS id`, [freshVersion()]))[0].id as string;
      expect(await call(`SELECT public.retention_policy_approve($1, $2, $3) AS ok`, [pid, admin1, `fixture-${run}-${seq}`]).then((r) => r[0].ok)).toBe(true);
      expect(await msg(call(`SELECT * FROM public.retention_execute_onboarding_events($1, 0)`, [pid]))).toMatch(/RETENTION_BATCH_INVALID/);
      const r1 = (await call(`SELECT * FROM public.retention_execute_onboarding_events($1, 500)`, [pid]))[0];
      expect(r1.out_failed_pairs).toBe(0);
      const ev = (await q(`SELECT erased_at, customer_id FROM customer_onboarding_events WHERE id = $1`, [oldEv]))[0];
      expect(ev.erased_at).not.toBeNull();
      expect(ev.customer_id).toBeNull();
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1 AND erased_at IS NULL`, [held.id]))[0].n).toBeGreaterThanOrEqual(2); // held customer untouched
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE customer_id = $1 AND erased_at IS NULL`, [fresh.id]))[0].n).toBe(1); // recent event untouched
      const r2 = (await call(`SELECT * FROM public.retention_execute_onboarding_events($1, 500)`, [pid]))[0];
      expect(r2.out_processed_pairs).toBeLessThanOrEqual(r1.out_processed_pairs); // nothing left to do for the same pairs
      expect((await q(`SELECT mode, policy_id FROM retention_runs WHERE id = $1`, [r1.out_run_id]))[0]).toEqual({ mode: 'execute', policy_id: pid });
      await call(`SELECT public.retention_policy_disable($1)`, [pid]);
      expect(await msg(call(`SELECT * FROM public.retention_execute_onboarding_events($1, 10)`, [pid]))).toMatch(/RETENTION_POLICY_NOT_ENABLED/);
    });
  });

  /** Extra fixture used only by the sweep: every kind of row that carries the phone or email. */
  async function fixtureRowsForSweep(w: World, c: { id: string; phone: string; email: string }) {
    await q(`INSERT INTO customer_credentials (customer_id, password_hash, password_set_at, password_changed_at, login_email, login_email_verified_at) VALUES ($1, 'h', now(), now(), $2, now())`, [c.id, c.email]);
    await q(`INSERT INTO notifications (business_id, customer_id, event_type, channel, recipient_address, body) VALUES ($1, $2, 'points_earned', 'sms', $3, 'x')`, [w.biz, c.id, c.phone]);
    await q(`INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, 'c', now() + interval '5 minutes')`, [c.phone]);
    const fx = await connect();
    await fx.query(`SET session_replication_role = replica`);
    await fx.query(`INSERT INTO feedback (business_id, branch_id, qr_code_id, rating, customer_name, customer_email, customer_phone) VALUES ($1, $2, gen_random_uuid(), 5, 'Real Name', $3, $4)`, [w.biz, w.b1, c.email, c.phone]);
    const conv = (await q(`INSERT INTO conversations (customer_id, business_id, last_message_preview) VALUES ($1, $2, $3) RETURNING id`, [c.id, w.biz, `call ${c.phone}`]))[0].id;
    await q(`INSERT INTO messages (conversation_id, sender_type, sender_id, body) VALUES ($1, 'customer', $2, $3)`, [conv, c.id, `my email is ${c.email}`]);
  }
});
