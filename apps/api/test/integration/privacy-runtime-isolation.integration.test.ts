import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { CustomerMembershipService } from '../../src/customer-relationships/customer-membership.service';

/**
 * R8-G + D2-FINAL COMBINED, against REAL PostgreSQL: the privacy infrastructure seen from the genuine non-owner application LOGIN.
 * The runtime role is provisioned from the committed SQL; every attack is made through a real LOGIN session. Each denial is asserted at the
 * privilege boundary itself (PostgreSQL's permission error) or at the guard that must hold even for a role that DOES hold the table privilege.
 * Development evidence on a disposable database; nothing here touches a shared environment.
 */
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) throw new Error('Needs a loopback PostgreSQL database.');

const dir = resolve(__dirname, '../../scripts/runtime-role');
const run = randomUUID().replace(/-/g, '').slice(0, 10);
const LOGIN = `d2rt_login_${run}`;
const OPLOGIN = `d2rt_op_${run}`;
const PASSWORD = randomBytes(18).toString('hex');
const consent = { consentVersion: 'v1' as const };

const PRIVACY_FUNCTIONS = [
  `public.privacy_request_submit(gen_random_uuid(), 'x', 'platform_assisted')`,
  `public.privacy_request_advance(gen_random_uuid(), 'scope_assessment', gen_random_uuid())`,
  `public.privacy_request_record_verification(gen_random_uuid(), 'out_of_band_platform_verified', 'e', gen_random_uuid())`,
  `public.privacy_request_approve(gen_random_uuid(), gen_random_uuid(), 'x')`,
  `public.privacy_request_reject(gen_random_uuid(), gen_random_uuid(), 'rejected_duplicate')`,
  `public.legal_hold_place(gen_random_uuid(), NULL, 'legal_proceeding', 'h', gen_random_uuid())`,
  `public.legal_hold_release(gen_random_uuid(), gen_random_uuid())`,
  `public.privacy_anonymize_customer(gen_random_uuid())`,
  `public.retention_policy_register('customer_onboarding_events', 1, 30, false)`,
  `public.retention_policy_approve(gen_random_uuid(), gen_random_uuid(), 'x')`,
  `public.retention_policy_disable(gen_random_uuid())`,
  `public.retention_preview_onboarding_events(30)`,
  `public.retention_execute_onboarding_events(gen_random_uuid(), 1)`,
  `public.onboarding_erase_customer_events(gen_random_uuid(), gen_random_uuid(), 'req', false)`,
];
const PRIVACY_TABLES = ['privacy_requests', 'privacy_request_transitions', 'legal_holds', 'retention_policies', 'retention_runs', 'onboarding_erasure_operations'];

describe.skipIf(!databaseUrl)('R8-G + D2-FINAL combined: privacy infrastructure under the non-owner runtime login (real PostgreSQL)', () => {
  let admin: Client;
  let adminRepos: ReturnType<typeof createRepositories>;
  const opened: Client[] = [];
  const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;
  const msg = async (p: Promise<unknown>): Promise<string> => { try { await p; return ''; } catch (e) { const err = e as Error & { cause?: { message?: string } }; return `${err.message} ${err.cause?.message ?? ''}`; } };
  const url = (user: string) => { const u = new URL(databaseUrl as string); u.username = user; u.password = PASSWORD; return u.toString(); };
  const runtime = async (): Promise<Client> => { const c = new Client({ connectionString: url(LOGIN) }); await c.connect(); opened.push(c); return c; };

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    adminRepos = createRepositories(buildDb(admin));
    await admin.query(`CREATE ROLE ${LOGIN} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(readFileSync(resolve(dir, 'provision-runtime-role.sql'), 'utf8').replaceAll('REPLACE_WITH_RUNTIME_LOGIN', LOGIN));
    // a second, separate login that IS a privacy operator, to prove the operator is not the runtime and that the runtime cannot become it
    await admin.query(`CREATE ROLE ${OPLOGIN} LOGIN PASSWORD '${PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE`);
    await admin.query(`GRANT customer_privacy_operator TO ${OPLOGIN}`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${OPLOGIN}`);
  });

  afterAll(async () => {
    for (const c of opened) await c.end().catch(() => undefined);
    await admin?.query(`REVOKE customer_privacy_operator FROM ${OPLOGIN}`).catch(() => undefined);
    await admin?.query(`REVOKE echogrid_app_runtime FROM ${LOGIN}`).catch(() => undefined);
    for (const r of [LOGIN, OPLOGIN]) { await admin?.query(`DROP OWNED BY ${r}`).catch(() => undefined); await admin?.query(`DROP ROLE IF EXISTS ${r}`).catch(() => undefined); }
    await admin?.end();
    }, 60_000);

  describe('the runtime can reach none of the privacy machinery', () => {
    it('cannot execute any of the 13 privacy functions or the 0084 erasure function (no EXECUTE at the privilege boundary)', async () => {
      const c = await runtime();
      for (const call of PRIVACY_FUNCTIONS) expect(await msg(c.query(`SELECT ${call}`)), call).toMatch(/permission denied for function/i);
    });

    it('cannot assume the privacy owner, the privacy operator, the erasure roles or the group role of another authority', async () => {
      const c = await runtime();
      for (const role of ['customer_privacy_owner', 'customer_privacy_operator', 'onboarding_erasure_owner', 'onboarding_erasure_operator']) {
        expect(await msg(c.query(`SET ROLE ${role}`)), role).toMatch(/permission denied to set role/i);
      }
      expect(await msg(c.query(`SET SESSION AUTHORIZATION ${OPLOGIN}`))).toMatch(/permission denied/i); // cannot become the real operator login either
      expect((await c.query(`SELECT current_user`)).rows[0].current_user).toBe(LOGIN);
    });

    it('cannot read, write, delete or truncate any privacy table, change a retention policy, approve its own request, or lift a legal hold', async () => {
      const c = await runtime();
      for (const t of PRIVACY_TABLES) {
        for (const sql of [`SELECT 1 FROM ${t} LIMIT 1`, `DELETE FROM ${t}`, `TRUNCATE ${t}`]) expect(await msg(c.query(sql)), sql).toMatch(/permission denied|cannot truncate/i);
        for (const verb of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) expect((await q(`SELECT has_table_privilege($1, $2, $3) AS ok`, [LOGIN, `public.${t}`, verb]))[0].ok, `${t} ${verb}`).toBe(false);
      }
      expect(await msg(c.query(`UPDATE retention_policies SET enabled = true`))).toMatch(/permission denied/i);
      expect(await msg(c.query(`UPDATE privacy_requests SET state = 'approved'`))).toMatch(/permission denied/i);
      expect(await msg(c.query(`UPDATE legal_holds SET released_at = now()`))).toMatch(/permission denied/i);
      expect(await msg(c.query(`INSERT INTO privacy_requests (request_ref, customer_id, channel) VALUES ('x', gen_random_uuid(), 'platform_assisted')`))).toMatch(/permission denied/i);
    });

    it('holds UPDATE on customers yet still cannot anonymize, un-anonymize or put identifiers back: the database guards stop it even though the privilege exists', async () => {
      const cust = (await adminRepos.customers.create({ phone: `+1553${run.replace(/\D/g, '').padEnd(6, '1').slice(0, 5)}001`, phoneVerifiedAt: new Date() })).id;
      const c = await runtime();
      expect((await q(`SELECT has_table_privilege($1, 'customers', 'UPDATE') AS ok`, [LOGIN]))[0].ok).toBe(true);
      expect(await msg(c.query(`UPDATE customers SET anonymized_at = now(), phone = NULL, full_name = NULL, email = NULL, birthday = NULL, phone_verified_at = NULL, preferred_locale = NULL WHERE id = $1`, [cust])))
        .toMatch(/CUSTOMER_ANONYMIZATION_RESTRICTED/);
      expect((await q(`SELECT anonymized_at FROM customers WHERE id = $1`, [cust]))[0].anonymized_at).toBeNull();
      // an anonymized shell (made by the privacy owner path) cannot be revived or re-identified by the runtime
      const shell = (await adminRepos.customers.create({ phone: `+1553${run.replace(/\D/g, '').padEnd(6, '1').slice(0, 5)}002`, phoneVerifiedAt: new Date() })).id;
      await admin.query('BEGIN');
      await admin.query(`SET LOCAL ROLE customer_privacy_owner`);
      await admin.query(`UPDATE customers SET phone = NULL, phone_verified_at = NULL, anonymized_at = now() WHERE id = $1`, [shell]);
      await admin.query('COMMIT');
      expect(await msg(c.query(`UPDATE customers SET anonymized_at = NULL WHERE id = $1`, [shell]))).toMatch(/CUSTOMER_ANONYMIZATION_IRREVERSIBLE/);
      expect(await msg(c.query(`UPDATE customers SET phone = '+15550000001', email = 'x@example.test' WHERE id = $1`, [shell]))).toMatch(/customers_anonymized_shape_check/);
      for (const t of ['business_customer_memberships', 'customer_credentials', 'customer_sessions']) {
        expect(await msg(c.query(`TRUNCATE ${t}`)), t).toMatch(/permission denied|cannot truncate/i);
      }
    });

    it('cannot change protected audit history (immutable and not even privileged), and its audit INSERT keeps working', async () => {
      const c = await runtime();
      const biz = (await adminRepos.businesses.create({ name: `D2RT ${run}`, slug: `d2rt-${run}` })).id;
      const id = (await c.query(`INSERT INTO audit_log (business_id, action, entity_type, metadata) VALUES ($1, 'd2rt.insert', 'd2rt', '{}'::jsonb) RETURNING id`, [biz])).rows[0].id as string;
      for (const sql of [`UPDATE audit_log SET metadata = '{"x":1}'::jsonb WHERE id = '${id}'`, `DELETE FROM audit_log WHERE id = '${id}'`, `TRUNCATE audit_log`]) {
        expect(await msg(c.query(sql)), sql).toMatch(/permission denied|cannot truncate/i);
      }
      expect((await q(`SELECT metadata FROM audit_log WHERE id = $1`, [id]))[0].metadata).toEqual({});
    });
  });

  describe('legitimate work still succeeds under the runtime login, and the privacy guards behave correctly under its privileges', () => {
    it('registration, business, branch, membership join with its onboarding event and audit row all succeed', async () => {
      const c = await runtime();
      const repos = createRepositories(buildDb(c));
      const biz = (await repos.businesses.create({ name: `D2RT join ${run}`, slug: `d2rt-j-${run}` })).id;
      const branch = (await repos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const cust = (await repos.customers.create({ phone: `+1553${run.replace(/\D/g, '').padEnd(6, '3').slice(0, 5)}003`, phoneVerifiedAt: new Date() })).id;
      await new CustomerMembershipService(buildDb(c)).join({
        customerId: cust, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}`, ...consent,
        attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}` },
      });
      expect((await q(`SELECT count(*)::int AS n FROM customer_onboarding_events WHERE business_id = $1 AND customer_id = $2`, [biz, cust]))[0].n).toBe(1);
      const audit = (await q(`SELECT metadata FROM audit_log WHERE business_id = $1 AND action = 'customer.onboarded'`, [biz]))[0];
      expect(audit.metadata).not.toHaveProperty('membershipId'); // forward minimization holds through the real service under the runtime role
    });

    it('an anonymized customer is refused new activity BY THE TRIGGERS even though the runtime holds INSERT: membership, credential, session and onboarding event', async () => {
      const biz = (await adminRepos.businesses.create({ name: `D2RT anon ${run}`, slug: `d2rt-a-${run}` })).id;
      const branch = (await adminRepos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const shell = (await adminRepos.customers.create({ phone: `+1553${run.replace(/\D/g, '').padEnd(6, '4').slice(0, 5)}004`, phoneVerifiedAt: new Date() })).id;
      await admin.query('BEGIN');
      await admin.query(`SET LOCAL ROLE customer_privacy_owner`);
      await admin.query(`UPDATE customers SET phone = NULL, phone_verified_at = NULL, anonymized_at = now() WHERE id = $1`, [shell]);
      await admin.query('COMMIT');
      const c = await runtime();
      const service = new CustomerMembershipService(buildDb(c));
      const joined = await msg(service.join({ customerId: shell, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}-s`, ...consent, attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}-s` } }));
      expect(joined).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      expect(await msg(c.query(`INSERT INTO customer_sessions (customer_id, auth_method, absolute_expires_at, idle_expires_at) VALUES ($1, 'otp', now() + interval '1 day', now() + interval '1 hour')`, [shell]))).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      expect(await msg(c.query(`INSERT INTO customer_credentials (customer_id, password_hash, password_set_at, password_changed_at) VALUES ($1, 'h', now(), now())`, [shell]))).toMatch(/CUSTOMER_ANONYMIZED_NO_NEW_ACTIVITY/);
      expect((await q(`SELECT count(*)::int AS n FROM business_customer_memberships WHERE customer_id = $1`, [shell]))[0].n).toBe(0);
    });

    it('the real privacy operator LOGIN (a different principal) CAN run the workflow end to end, which proves the denials above are about the runtime and not a broken function', async () => {
      const biz = (await adminRepos.businesses.create({ name: `D2RT op ${run}`, slug: `d2rt-o-${run}` })).id;
      const branch = (await adminRepos.branches.create({ businessId: biz, name: 'B1', slug: 'b1' })).id;
      const cust = (await adminRepos.customers.create({ phone: `+1553${run.replace(/\D/g, '').padEnd(6, '5').slice(0, 5)}005`, phoneVerifiedAt: new Date() })).id;
      await new CustomerMembershipService(buildDb(admin)).join({ customerId: cust, businessId: biz, onboardingSource: 'business_qr', onboardingReference: `qr-${run}-o`, ...consent, attribution: { source: 'business_qr', branchId: branch, reference: `qr-${run}-o` } });
      const mk = async (label: string, role: string) => (await q(`INSERT INTO users (email, full_name, password_hash, status, platform_role) VALUES ($1, $2, 'x', 'active', $3) RETURNING id`, [`d2rt-${label}-${run}@example.test`, label, role]))[0].id as string;
      const verifier = await mk('verifier', 'support');
      const approver = await mk('approver', 'admin');
      const op = new Client({ connectionString: url(OPLOGIN) });
      await op.connect();
      opened.push(op);
      const id = (await op.query(`SELECT public.privacy_request_submit($1, $2, 'platform_assisted') AS id`, [cust, `d2rt-${run}`])).rows[0].id as string;
      await op.query(`SELECT public.privacy_request_advance($1, 'identity_verification_required', $2)`, [id, verifier]);
      await op.query(`SELECT public.privacy_request_record_verification($1, 'out_of_band_platform_verified', $2, $3)`, [id, `ev-${run}`, verifier]);
      await op.query(`SELECT public.privacy_request_advance($1, 'scope_assessment', $2)`, [id, verifier]);
      await op.query(`SELECT public.privacy_request_advance($1, 'retention_assessment', $2)`, [id, verifier]);
      await op.query(`SELECT public.privacy_request_approve($1, $2, 'ap-1')`, [id, approver]);
      const out = (await op.query(`SELECT * FROM public.privacy_anonymize_customer($1)`, [id])).rows[0];
      expect(out.out_outcome).toBe('completed');
      expect((await q(`SELECT actor_role FROM privacy_request_transitions WHERE request_id = $1 LIMIT 1`, [id]))[0].actor_role).toBe(OPLOGIN); // session_user is the real login
      // and that same operator login cannot touch the application's other tables
      expect(await msg(op.query(`SELECT 1 FROM audit_log LIMIT 1`))).toMatch(/permission denied/i);
      expect(await msg(op.query(`DELETE FROM loyalty_accounts`))).toMatch(/permission denied/i);
    });
  });
});
