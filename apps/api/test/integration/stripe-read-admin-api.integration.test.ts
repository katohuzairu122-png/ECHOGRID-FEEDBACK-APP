/* eslint-disable @typescript-eslint/no-explicit-any -- request/response fixtures and raw SQL */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { signAccessToken } from '../../src/auth/jwt';
import { errorHandler } from '../../src/lib/error-handler';
import type { Bindings } from '../../src/config/env';
import { createStripeReadAdminRoutes } from '../../src/internal/stripe-read-admin.routes';
import { authorizeRead, checkRead, createDurableAuthorizationStore, MappingRegistry } from '../../src/billing/stripe-read';

/**
 * S08-D1D3-DEV-12 on PostgreSQL, in a SCRATCH database: the internal administrator API end to end over the REAL users / refresh_tokens / businesses records and the DEV-10 durable authorization store,
 * connected as a NON-SUPERUSER application login. The operational policy is disabled by default and is enabled here only by the test harness acting as the database owner, in a disposable database.
 * No Stripe, provider, Neon or production resource: the platform fetch is a stub that must never be called.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-12 administrator API (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_d12_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const PW = 'dev12-' + randomBytes(6).toString('hex');
  const SECRET = 'dev12-integration-secret-0123456789abcdef';
  const GATEWAY = 'k'.repeat(48);
  const ACCT = 'acct_Dev12Account1'; const WORKLOAD = 'wl-d12-verifier';
  const clients: Client[] = [];
  let admin: Client; let biz: string; let bizOther: string; let a1: string; let a2: string; let plain: string;
  const open: Client[] = [];
  const connectAs = async (login: string) => { const u = new URL(urlFor(dbName)); u.username = login; u.password = PW; const c = new Client({ connectionString: u.toString() }); await c.connect(); open.push(c); return c; };
  const q = async <T extends Record<string, any> = Record<string, any>>(text: string, params: unknown[] = []) => (await admin.query<T>(text, params)).rows;
  const tryQ = async (c: Client, text: string, params: unknown[] = []) => { try { return { error: '', rows: (await c.query(text, params)).rows as Array<Record<string, any>> }; } catch (e) { return { error: String((e as Error).message), rows: [] as Array<Record<string, any>> }; } };
  const fetchCalls: string[] = [];

  /** The router under test, wired to a fresh non-superuser application connection per request (as the Hyperdrive-backed default would be). */
  const makeApp = (over: { login?: string; workload?: boolean; openDbThrows?: boolean; methods?: string[] } = {}) => {
    const passthrough = createMiddleware(async (_c, next) => next());
    const routes = createStripeReadAdminRoutes({
      limiter: passthrough as never, clock: () => Date.now(),
      openDb: async () => { if (over.openDbThrows) throw new Error('db down'); const c = await connectAs(over.login ?? 'dev12_l_app'); return { db: buildDb(c), close: async () => { await c.end().catch(() => undefined); } }; },
      workloadConfig: over.workload === false ? null : { load: async () => ({ workloadId: WORKLOAD, environment: 'development', accountId: ACCT, realm: 'test', methods: over.methods ?? ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], credentialRef: 'cred:d12', signingKeyPurpose: 'SYNTHETIC_RUNTIME', validFromMs: 0, expiresAtMs: Date.now() + 86_400_000, revokedAtMs: null }) },
    });
    const app = new Hono<{ Bindings: Bindings }>(); app.onError(errorHandler); app.route('/internal/stripe-read', routes);
    return app;
  };
  const ENV = { ENVIRONMENT: 'development', JWT_ACCESS_SECRET: SECRET, INTERNAL_STRIPE_READ_ADMIN_API: 'enabled', INTERNAL_API_GATEWAY_TOKEN: GATEWAY } as unknown as Bindings;
  let app = makeApp();
  const sessions = new Map<string, { sid: string; rowId: string }>();
  async function session(userId: string) {
    const sid = randomUUID(); const rowId = randomUUID();
    await q("insert into refresh_tokens(id, user_id, token_hash, session_id, expires_at) values($1,$2,$3,$4,now()+interval '1 day')", [rowId, userId, randomUUID(), sid]);
    const auth = `Bearer ${await signAccessToken(userId, SECRET, sid)}`; sessions.set(auth, { sid, rowId });
    return { auth, sid, rowId };
  }
  const call = (a: Hono<any>, path: string, auth: string | null, init: { method?: string; json?: unknown; raw?: string; headers?: Record<string, string> } = {}) =>
    a.request(`/internal/stripe-read${path}`, {
      method: init.method ?? (init.json !== undefined || init.raw !== undefined ? 'POST' : 'GET'),
      headers: { 'x-internal-gateway-token': GATEWAY, ...(auth ? { authorization: auth } : {}), ...(init.json !== undefined || init.raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.raw !== undefined ? { body: init.raw } : {}),
    }, ENV);
  const j = async (r: Response) => r.json() as Promise<any>;
  let n = 0;
  const proposal = (over: Record<string, unknown> = {}) => ({ businessId: biz, accountId: ACCT, methodId: 'INVOICE_RETRIEVE', realm: 'test', workloadId: WORKLOAD, validFromMs: 1, expiresAtMs: Date.now() + 3_600_000, inventoryRevision: `rev-${++n}`, ...over });
  /** Each test proposes on its own method/account-free tuple: the workload binds one account, so tuples are separated by business. */
  const mkBusiness = async () => (await q<{ id: string }>("insert into businesses(name,slug,status) values($1,$2,'active') returning id", [`D12 ${++n}`, `d12-${dbName}-${n}`]))[0]!.id;
  const mkUser = async (role: string | null, status = 'active') => (await q<{ id: string }>('insert into users(email,password_hash,full_name,status,platform_role) values($1,$2,$3,$4,$5) returning id', [`d12-${randomUUID()}@example.test`, 'x', 'D12', status, role]))[0]!.id;
  const policy = (on: boolean) => q('update stripe_read_authorization_policy set approval_enabled = $1', [on]);

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed: ' + m.stderr.slice(0, 400));
    admin = new Client({ connectionString: urlFor(dbName) }); await admin.connect(); clients.push(admin);
    biz = await mkBusiness(); bizOther = await mkBusiness();
    a1 = await mkUser('admin'); a2 = await mkUser('admin'); plain = await mkUser(null);
    // the application login: not a superuser, no BYPASSRLS, the two DEV-10 roles it needs, and ordinary SELECT on the three tables authentication and scope checks read
    await q(`CREATE ROLE dev12_l_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO dev12_l_app`);
    await q('GRANT stripe_read_auth_admin, stripe_read_auth_auditor TO dev12_l_app'); await q('GRANT SELECT ON users, refresh_tokens, businesses TO dev12_l_app');
    await q(`CREATE ROLE dev12_l_verifier LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO dev12_l_verifier`); await q('GRANT stripe_read_auth_verifier TO dev12_l_verifier');
    await q(`CREATE ROLE dev12_l_norole LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO dev12_l_norole`); await q('GRANT SELECT ON users, refresh_tokens, businesses TO dev12_l_norole');
    vi.stubGlobal('fetch', async (u: any) => { fetchCalls.push(String(u)); return new Response('{}'); });
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const c of open) await c.end().catch(() => undefined);
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') }); await root.connect();
    await root.query(`drop database if exists ${dbName} with (force)`);
    for (const l of ['dev12_l_app', 'dev12_l_norole', 'dev12_l_verifier']) { try { await root.query(`DROP OWNED BY ${l}`); await root.query(`DROP ROLE IF EXISTS ${l}`); } catch { /* shared cluster */ } }
    await root.end();
  });

  describe('default-disabled policy', () => {
    it('19-28(part). with the policy disabled (the shipped default) no operational proposal or approval is possible, through the API or around it', async () => {
      const s1 = await session(a1);
      const before = (await q('select (select count(*)::int from stripe_read_authorizations) a, (select count(*)::int from stripe_read_authorization_events) e'))[0]!;
      const st = await call(app, '/policy', s1.auth);
      expect([st.status, (await j(st)).data]).toEqual([200, { approvalEnabled: false, state: 'DISABLED', mutableThroughApi: false }]);
      const p = await call(app, '/authorizations', s1.auth, { json: proposal() });
      expect([p.status, (await j(p)).error.code]).toEqual([409, 'APPROVAL_POLICY_DISABLED']);
      const ap = await call(app, `/authorizations/${randomUUID()}/approve`, (await session(a2)).auth, { json: { evidenceRef: 'EV' } });
      expect([ap.status, (await j(ap)).error.code]).toEqual([409, 'APPROVAL_POLICY_DISABLED']);
      expect((await q('select (select count(*)::int from stripe_read_authorizations) a, (select count(*)::int from stripe_read_authorization_events) e'))[0]).toEqual(before);
      // no HTTP verb or path can change the policy; the database row is unchanged
      for (const [m, path] of [['POST', '/policy'], ['PUT', '/policy'], ['PATCH', '/policy'], ['POST', '/policy/enable'], ['POST', '/policy/approval']]) expect((await call(app, path!, s1.auth, { method: m!, json: { approvalEnabled: true } })).status, `${m} ${path}`).toBe(404);
      expect((await q('select approval_enabled from stripe_read_authorization_policy'))[0]!.approval_enabled).toBe(false);
      // and the application login itself cannot write the policy
      const appC = await connectAs('dev12_l_app');
      try { expect((await tryQ(appC, 'update stripe_read_authorization_policy set approval_enabled = true')).error).toMatch(/permission denied/); } finally { await appC.end(); }
      // only the table owner (the migration/harness role) can write the policy: no DEV-10 role holds UPDATE, INSERT or DELETE on it
      const grants = await q("select grantee, string_agg(privilege_type, ',' order by privilege_type) p from information_schema.role_table_grants where table_name = 'stripe_read_authorization_policy' and grantee not in (select rolname from pg_roles where rolsuper) group by grantee order by grantee");
      for (const g of grants) expect(g.p, g.grantee).toBe('SELECT');
      expect((await q("select count(*)::int n from pg_roles r join pg_class c on c.relname='stripe_read_authorization_policy' where c.relowner = r.oid and r.rolname like 'stripe_read_auth_%'"))[0]!.n).toBe(0); // and the owner is not one of the DEV-10 roles
      await policy(true); // harness acting as the database OWNER in a disposable database, never the API
      expect((await j(await call(app, '/policy', s1.auth))).data).toEqual({ approvalEnabled: true, state: 'ENABLED', mutableThroughApi: false });
    });
  });

  describe('11-20. proposals', () => {
    it('a valid proposal creates a PENDING authorization attributed to the SESSION administrator; it is not approved, authorizes nothing and makes no Stripe request', async () => {
      const s1 = await session(a1); const b = await mkBusiness(); fetchCalls.length = 0;
      // a forged administrator in the header, query or body changes nothing
      const res = await call(app, `/authorizations?adminUserId=${a2}`, s1.auth, { json: proposal({ businessId: b }), headers: { 'x-admin-user-id': a2 } });
      const out = await j(res); expect(res.status).toBe(201); expect(out.data).toMatchObject({ state: 'PENDING', authorizationId: expect.stringMatching(/^[0-9a-f-]{36}$/), correlationId: expect.any(String) });
      const row = (await q('select state, version, proposed_by, approved_by, workload_id, account_id, realm, inventory_record_id from stripe_read_authorizations where id = $1', [out.data.authorizationId]))[0]!;
      expect(row).toMatchObject({ state: 'PENDING', version: 1, proposed_by: a1, approved_by: null, workload_id: WORKLOAD, account_id: ACCT, realm: 'test', inventory_record_id: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001' });
      expect(await q('select event_type, actor_id from stripe_read_authorization_events where authorization_id = $1', [out.data.authorizationId])).toEqual([{ event_type: 'PROPOSED', actor_id: a1 }]);
      const store = createDurableAuthorizationStore(buildDb(await connectAs('dev12_l_verifier')));
      expect(await authorizeRead(store, { businessId: b, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', realm: 'test' }, Date.now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_NOT_APPROVED' }); // 18: never auto-approved
      expect(fetchCalls).toEqual([]); // 20
    });

    it('12-17. unsupported methods, a live realm, an unknown business, a wrong account, a forged workload reference and a duplicate are all refused', async () => {
      const s1 = await session(a1); const b = await mkBusiness();
      const post = async (over: Record<string, unknown>, a: Hono<any> = app) => { const r = await call(a, '/authorizations', s1.auth, { json: proposal({ businessId: b, ...over }) }); return [r.status, (await j(r)).error?.code] as const; };
      expect(await post({ methodId: 'REFUNDS_LIST' })).toEqual([422, 'INVALID_REQUEST']); // 12
      expect(await post({ businessId: randomUUID() })).toEqual([404, 'NOT_FOUND']); // 13: unknown business
      expect(await post({ accountId: 'acct_SomeoneElse1' })).toEqual([422, 'UNTRUSTED_WORKLOAD_REFERENCE']); // 14: not the trusted workload's account
      expect(await post({ realm: 'live' })).toEqual([422, 'INVALID_REQUEST']); // 15
      expect(await post({}, makeApp({ methods: ['ACCOUNT_RETRIEVE_CURRENT'] }))).toEqual([422, 'UNTRUSTED_WORKLOAD_REFERENCE']); // the trusted workload is not scoped to this method
      expect(await post({ workloadId: 'wl-forged' })).toEqual([422, 'UNTRUSTED_WORKLOAD_REFERENCE']); // 16
      expect(await post({}, makeApp({ workload: false }))).toEqual([409, 'WORKLOAD_NOT_PROVISIONED']); // no trusted workload at all: fail closed
      const suspended = await mkBusiness(); await q("update businesses set status='suspended' where id=$1", [suspended]);
      expect(await post({ businessId: suspended })).toEqual([404, 'NOT_FOUND']);
      expect(await post({})).toEqual([201, undefined]);
      expect(await post({})).toEqual([409, 'DUPLICATE_ACTIVE_AUTHORIZATION']); // 17: replaying the proposal creates no second live authority
      expect(await post({ methodId: 'ACCOUNT_RETRIEVE_CURRENT' })).toEqual([201, undefined]); // a different method is a different tuple
    });
  });

  describe('21-32. approval, revocation, status', () => {
    async function proposed(over: Record<string, unknown> = {}) {
      const s1 = await session(a1); const s2 = await session(a2); const b = await mkBusiness();
      const r = await call(app, '/authorizations', s1.auth, { json: proposal({ businessId: b, ...over }) }); const out = await j(r);
      if (r.status !== 201) throw new Error('proposal ' + JSON.stringify(out));
      return { s1, s2, b, id: out.data.authorizationId as string };
    }

    it('21-22. self-approval and non-administrators are refused; the approving administrator comes from the session', async () => {
      const { s1, s2, id } = await proposed(); const sp = await session(plain);
      const self = await call(app, `/authorizations/${id}/approve`, s1.auth, { json: { evidenceRef: 'SELF' } });
      expect([self.status, (await j(self)).error.code]).toEqual([403, 'SELF_APPROVAL_REFUSED']);
      const np = await call(app, `/authorizations/${id}/approve`, sp.auth, { json: { evidenceRef: 'PLAIN' } }); expect(np.status).toBe(403);
      const forged = await call(app, `/authorizations/${id}/approve`, s1.auth, { json: { evidenceRef: 'E', approvedBy: a2 } }); expect(forged.status).toBe(422);
      const viaHeader = await call(app, `/authorizations/${id}/approve?approvedBy=${a2}`, s1.auth, { json: { evidenceRef: 'E' }, headers: { 'x-admin-user-id': a2 } });
      expect([viaHeader.status, (await j(viaHeader)).error.code]).toEqual([403, 'SELF_APPROVAL_REFUSED']); // still the session's own identity
      expect((await q('select state from stripe_read_authorizations where id=$1', [id]))[0]!.state).toBe('PENDING');
      const ok = await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EVIDENCE-1' } });
      expect([ok.status, (await j(ok)).data]).toEqual([200, expect.objectContaining({ state: 'APPROVED', version: 2 })]);
      expect((await q('select approved_by from stripe_read_authorizations where id=$1', [id]))[0]!.approved_by).toBe(a2);
      const replay = await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EVIDENCE-1' } });
      expect([replay.status, (await j(replay)).data.version]).toEqual([200, 2]); // replay: same version, no additional authority
      const other = await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EVIDENCE-2' } });
      expect([other.status, (await j(other)).error.code]).toEqual([409, 'ALREADY_APPROVED']);
      expect((await q("select count(*)::int n from stripe_read_authorization_events where authorization_id=$1 and event_type='APPROVED'", [id]))[0]!.n).toBe(1);
    });

    it('23-24. an expired proposal cannot be approved, a revoked authorization cannot be restored, a missing one is 404', async () => {
      const { s1, s2, id } = await proposed({ expiresAtMs: Date.now() + 1200 });
      await new Promise(r => setTimeout(r, 1400));
      const late = await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'LATE' } });
      expect([late.status, (await j(late)).error.code]).toEqual([409, 'AUTHORIZATION_EXPIRED']);
      const p = await proposed(); await call(app, `/authorizations/${p.id}/revoke`, p.s1.auth, { json: { reason: 'OWNER_REQUEST' } });
      const back = await call(app, `/authorizations/${p.id}/approve`, p.s2.auth, { json: { evidenceRef: 'AGAIN' } });
      expect([back.status, (await j(back)).error.code]).toEqual([409, 'AUTHORIZATION_REVOKED']);
      expect((await call(app, `/authorizations/${randomUUID()}/approve`, s2.auth, { json: { evidenceRef: 'X' } })).status).toBe(404);
      void s1;
    });

    it('25. concurrent approvals are race-safe: one approver wins, repeats are idempotent, a competing approval is refused, and the audit trail has one approval', async () => {
      const { s2, id } = await proposed(); const s3 = await session(await mkUser('admin'));
      const results = await Promise.all([...Array.from({ length: 4 }, () => call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'RACE-A' } })), ...Array.from({ length: 4 }, () => call(app, `/authorizations/${id}/approve`, s3.auth, { json: { evidenceRef: 'RACE-B' } }))]);
      const codes = await Promise.all(results.map(async r => (r.status === 200 ? 'ok' : (await j(r)).error.code)));
      expect(codes.filter(c => c === 'ok').length).toBeGreaterThanOrEqual(1); expect(codes.filter(c => c !== 'ok').every(c => c === 'ALREADY_APPROVED')).toBe(true);
      expect((await q("select count(*)::int n from stripe_read_authorization_events where authorization_id=$1 and event_type='APPROVED'", [id]))[0]!.n).toBe(1);
      expect((await q('select version from stripe_read_authorizations where id=$1', [id]))[0]!.version).toBe(2);
    });

    it('26-28. approval cannot bypass the database or unlock restricted methods: direct SQL is refused, an approved record still needs a verified mapping, and the four unauthorized reads stay closed', async () => {
      const { s2, b, id } = await proposed();
      const ordinary = await connectAs('dev12_l_norole'); // a login WITHOUT the DEV-10 administrator role
      expect((await tryQ(ordinary, `update stripe_read_authorizations set state='APPROVED', version=2 where id='${id}'`)).error).toMatch(/permission denied/);
      expect((await tryQ(ordinary, `select public.stripe_read_auth_approve('${id}'::uuid, '${a2}'::uuid, 'X')`)).error).toMatch(/permission denied/);
      expect((await tryQ(ordinary, `insert into stripe_read_authorizations(business_id,account_id,realm,workload_id,method_id,state,valid_from_ms,expires_at_ms,inventory_record_id,inventory_revision,proposed_by) values('${b}','${ACCT}','test','${WORKLOAD}','INVOICE_RETRIEVE','APPROVED',1,9999999999999,'X','r','${a1}')`)).error).toMatch(/permission denied/);
      expect((await tryQ(admin, `update stripe_read_authorizations set state='APPROVED', version=2, approved_by='${plain}', approval_evidence_ref='E', approved_at_ms=0 where id='${id}'`)).error).toMatch(/READ_AUTH_ADMIN_REQUIRED/);
      expect((await tryQ(admin, `update stripe_read_authorizations set state='APPROVED', version=2, approved_by='${a1}', approval_evidence_ref='E', approved_at_ms=0 where id='${id}'`)).error).toMatch(/READ_AUTH_SELF_APPROVAL/);
      await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EV-Q' } });
      const store = createDurableAuthorizationStore(buildDb(await connectAs('dev12_l_verifier')));
      const gate = { store, workloadId: WORKLOAD, mapping: MappingRegistry.catalog() } as any;
      expect(await authorizeRead(store, { businessId: b, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', realm: 'test' }, Date.now())).toMatchObject({ allowed: true }); // authorized ...
      expect(await checkRead(gate, { businessId: b, accountId: ACCT, methodId: 'INVOICE_RETRIEVE', apiVersion: '2026-05-27.dahlia', purpose: 'EVIDENCE' }, Date.now())).toEqual({ ok: false, reason: 'MAPPING_NOT_VERIFIED' }); // ... yet no real evidence read: no verified mapping
      expect(MappingRegistry.catalog().entries().every(e => e.status !== 'TEST_MODE_VERIFIED')).toBe(true);
      // a row the database would accept for an unauthorized method authorizes nothing, and the API will not create one
      for (const m of ['REFUNDS_LIST', 'PAYMENT_RETRIEVE', 'INVOICE_LINES_LIST', 'DISPUTES_LIST']) {
        const r = await call(app, '/authorizations', (await session(a1)).auth, { json: proposal({ businessId: b, methodId: m }) }); expect(r.status, m).toBe(422);
        expect(await authorizeRead(store, { businessId: b, accountId: ACCT, workloadId: WORKLOAD, methodId: m, realm: 'test' }, Date.now()), m).toMatchObject({ allowed: false });
      }
    });

    it('29-32. authorized revocation is durable and idempotent, a revoked authorization is never reusable, and a revoked SESSION loses the API at once', async () => {
      const { s1, s2, b, id } = await proposed(); await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EV-R' } });
      expect((await call(app, `/authorizations/${id}/revoke`, s2.auth, { json: { reason: 'lowercase' } })).status).toBe(422);
      const r1 = await call(app, `/authorizations/${id}/revoke`, s1.auth, { json: { reason: 'OWNER_REQUEST' } });
      expect([r1.status, (await j(r1)).data]).toEqual([200, expect.objectContaining({ state: 'REVOKED', version: 3 })]);
      const r2 = await call(app, `/authorizations/${id}/revoke`, s2.auth, { json: { reason: 'OTHER_REASON' } }); expect([r2.status, (await j(r2)).data.version]).toEqual([200, 3]); // idempotent
      expect((await q('select state, version, revoked_by from stripe_read_authorizations where id=$1', [id]))[0]).toEqual({ state: 'REVOKED', version: 3, revoked_by: a1 }); // durable, first revoker kept
      const store = createDurableAuthorizationStore(buildDb(await connectAs('dev12_l_verifier')));
      expect(await authorizeRead(store, { businessId: b, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', realm: 'test' }, Date.now())).toEqual({ allowed: false, reason: 'AUTHORIZATION_REVOKED' });
      expect((await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EV-R' } })).status).toBe(409);
      // revoke ONLY session 1: the very next request is refused while the same administrator's other session still works
      const other = await session(a1);
      await q('update refresh_tokens set revoked_at = now() where id = $1', [s1.rowId]);
      expect((await call(app, `/authorizations/${id}?businessId=${b}`, s1.auth)).status).toBe(401);
      expect((await call(app, `/authorizations/${id}/revoke`, s1.auth, { json: { reason: 'AGAIN' } })).status).toBe(401);
      expect((await call(app, `/authorizations/${id}?businessId=${b}`, other.auth)).status).toBe(200);
    });

    it('33-38. status and audit require an administrator and an explicit matching scope, are bounded and deterministic, expose no secret or raw administrator id, and the trail is immutable', async () => {
      const { s1, s2, b, id } = await proposed({ expiresAtMs: Date.now() + 2500 });
      await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EV-S' } });
      expect((await call(app, `/authorizations/${id}?businessId=${b}`, null)).status).toBe(401); // 33
      expect((await call(app, `/authorizations/${id}/audit?businessId=${b}`, (await session(plain)).auth)).status).toBe(403); // 34
      expect((await call(app, `/authorizations/${id}`, s1.auth)).status).toBe(422); // a scope is mandatory
      expect((await call(app, `/authorizations/${id}?businessId=${bizOther}`, s1.auth)).status).toBe(404); // 35: a foreign scope looks like a missing id
      expect((await call(app, `/authorizations/${id}/audit?businessId=${bizOther}`, s1.auth)).status).toBe(404);
      const st = await j(await call(app, `/authorizations/${id}?businessId=${b}`, s1.auth));
      expect(st.data).toMatchObject({ authorizationId: id, businessId: b, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', state: 'APPROVED', storedState: 'APPROVED', version: 2 });
      await new Promise(r => setTimeout(r, 2700));
      const expired = await j(await call(app, `/authorizations/${id}?businessId=${b}`, s1.auth));
      expect(expired.data).toMatchObject({ state: 'EXPIRED', storedState: 'APPROVED' }); // derived, never stored
      await call(app, `/authorizations/${id}/revoke`, s1.auth, { json: { reason: 'CLEANUP' } });
      // audit: deterministic order, bounded pages, opaque administrator references
      const all = await j(await call(app, `/authorizations/${id}/audit?businessId=${b}`, s1.auth));
      expect(all.data.events.map((e: any) => [e.version, e.eventType])).toEqual([[1, 'PROPOSED'], [2, 'APPROVED'], [3, 'REVOKED']]);
      const page1 = await j(await call(app, `/authorizations/${id}/audit?businessId=${b}&limit=2`, s1.auth)); expect(page1.data.events).toHaveLength(2); expect(page1.data.nextAfterVersion).toBe(2);
      const page2 = await j(await call(app, `/authorizations/${id}/audit?businessId=${b}&limit=2&afterVersion=2`, s1.auth)); expect(page2.data.events.map((e: any) => e.version)).toEqual([3]); expect(page2.data.nextAfterVersion).toBeNull(); // 36
      for (const bad of ['limit=0', 'limit=101', 'limit=abc', 'afterVersion=-1', 'limit=5&extra=1']) expect((await call(app, `/authorizations/${id}/audit?businessId=${b}&${bad}`, s1.auth)).status, bad).toBe(422);
      const dump = JSON.stringify([st, all, page1]);
      expect(dump).not.toContain(a1); expect(dump).not.toContain(a2); // 38: no raw administrator id
      expect(dump).not.toMatch(/Bearer |eyJ|password|secret|rk_(test|live)|sk_(test|live)|signing|private|pkcs8|GATEWAY/i);
      expect(all.data.events[0].actorRef).toMatch(/^[0-9a-f]{16}$/); expect(all.data.events[0].actorRef).not.toBe(all.data.events[1].actorRef); // distinct administrators stay distinguishable
      expect((await tryQ(admin, `update stripe_read_authorization_events set actor_id='${a2}' where authorization_id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/); // 37
      expect((await tryQ(admin, `delete from stripe_read_authorization_events where authorization_id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      // the global audit-trail contract: every mutating response carried a correlation id
      const rv = await j(await call(app, `/authorizations/${id}/revoke`, s1.auth, { json: { reason: 'CLEANUP' } })); expect(rv.data.correlationId).toEqual(expect.any(String));
    });
  });

  describe('storage failure, privileges and financial isolation', () => {
    it('a store outage, an application login without the DEV-10 roles, and an unreadable policy fail closed', async () => {
      const s1 = await session(a1);
      const down = await call(makeApp({ openDbThrows: true }), '/policy', s1.auth); expect([down.status, (await j(down)).error.code]).toEqual([500, 'ADMIN_AUTH_UNAVAILABLE']);
      const noRole = makeApp({ login: 'dev12_l_norole' });
      const st = await call(noRole, `/authorizations/${randomUUID()}?businessId=${biz}`, s1.auth); expect([st.status, (await j(st)).error.code]).toEqual([500, 'AUTHORIZATION_STORE_UNAVAILABLE']);
      const prop = await call(noRole, '/authorizations', s1.auth, { json: proposal() }); expect([prop.status, (await j(prop)).error.code]).toEqual([409, 'APPROVAL_POLICY_DISABLED']); // an unreadable policy is a disabled policy
      const pol = await j(await call(noRole, '/policy', s1.auth)); expect(pol.data.state).toBe('UNKNOWN'); expect(pol.data.approvalEnabled).toBe(false);
      await q('alter table stripe_read_authorization_policy disable trigger stripe_read_authorization_policy_no_delete'); // harness: simulate a missing policy row, then restore it
      await q('delete from stripe_read_authorization_policy');
      expect((await j(await call(app, '/policy', s1.auth))).data).toMatchObject({ approvalEnabled: false, state: 'UNKNOWN' });
      expect((await call(app, '/authorizations', s1.auth, { json: proposal() })).status).toBe(409);
      await q('insert into stripe_read_authorization_policy(singleton, approval_enabled) values(true, true)'); await q('alter table stripe_read_authorization_policy enable trigger stripe_read_authorization_policy_no_delete');
      expect((await j(await call(app, '/policy', s1.auth))).data.state).toBe('ENABLED');
    });

    it('39-45. nothing in the administrator API reaches Stripe, evidence or the ledger: the platform fetch is never called, no ledger or settlement row moves, and the Q1/Q2 mapping state is untouched', async () => {
      const ledger = async () => (await q("select (select count(*)::int from partner_credit_ledger) l, (select count(*)::int from partner_credit_settlement_authorizations) s, (select count(*)::int from partner_credit_lots) lots"))[0]!;
      const before = await ledger(); fetchCalls.length = 0;
      const s1 = await session(a1); const s2 = await session(a2); const b = await mkBusiness();
      const id = (await j(await call(app, '/authorizations', s1.auth, { json: proposal({ businessId: b }) }))).data.authorizationId;
      await call(app, `/authorizations/${id}/approve`, s2.auth, { json: { evidenceRef: 'EV-F' } });
      await call(app, `/authorizations/${id}?businessId=${b}`, s1.auth); await call(app, `/authorizations/${id}/audit?businessId=${b}`, s1.auth);
      await call(app, `/authorizations/${id}/revoke`, s1.auth, { json: { reason: 'DONE' } });
      expect(fetchCalls).toEqual([]); // 39-40: no Stripe request of any kind
      expect(await ledger()).toEqual(before); // 44: zero ledger movement; 43: no settlement authorization
      expect(MappingRegistry.catalog().entries().every(e => e.status === 'SDK_SCHEMA_UNPROVEN_LIVE' || e.status === 'UNSUPPORTED')).toBe(true); // 41-42
      // unauthorized activity (anonymous, wrong gateway, revoked session) also moves nothing
      await call(app, '/authorizations', null, { json: proposal({ businessId: b }) });
      expect((await app.request('/internal/stripe-read/authorizations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, ENV)).status).toBe(404);
      expect(await ledger()).toEqual(before);
      expect((await q('select count(*)::int n from stripe_read_authorizations where business_id=$1', [b]))[0]!.n).toBe(1);
    });
  });
});
