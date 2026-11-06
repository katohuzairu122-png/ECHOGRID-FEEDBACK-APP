/* eslint-disable @typescript-eslint/no-explicit-any -- request/response fixtures and raw SQL */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { signAccessToken } from '../../src/auth/jwt';
import { errorHandler } from '../../src/lib/error-handler';
import type { Bindings } from '../../src/config/env';
import { createStripeReadAdminRoutes } from '../../src/internal/stripe-read-admin.routes';
import { authenticateAdminSession, createSessionRevalidator, AdminAuthorityError, type TrustedAdminContext } from '../../src/billing/stripe-read';
import { PolicyAdministrationService, PolicyAdministrationError } from '../../src/billing/stripe-read/policy-administration';

/**
 * S08-D1D3-DEV-13 on PostgreSQL, in a SCRATCH database: durable policy-change administration over the REAL users / refresh_tokens records, connected as a NON-SUPERUSER application login.
 * The approval policy (`approval_enabled`) is FALSE by default and nothing here ever sets it through the system under test; where a test needs a different value it plays the database OWNER in a disposable
 * database, which is exactly the out-of-band authority the product leaves undesignated. No Stripe, provider, Neon or production resource: the platform fetch is a stub that must never be called.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-13 policy administration (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_d13_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const PW = 'dev13-' + randomBytes(6).toString('hex');
  const SECRET = 'dev13-integration-secret-0123456789abcdef';
  const GATEWAY = 'k'.repeat(48);
  const clients: Client[] = []; const open: Client[] = [];
  let admin: Client; let a1: string; let a2: string; let a3: string; let plain: string;
  const fetchCalls: string[] = [];
  const connectAs = async (login: string) => { const u = new URL(urlFor(dbName)); u.username = login; u.password = PW; const c = new Client({ connectionString: u.toString() }); await c.connect(); open.push(c); return c; };
  const q = async <T extends Record<string, any> = Record<string, any>>(text: string, params: unknown[] = []) => (await admin.query<T>(text, params)).rows;
  const tryQ = async (c: Client, text: string, params: unknown[] = []) => { try { return { error: '', rows: (await c.query(text, params)).rows as Array<Record<string, any>> }; } catch (e) { return { error: String((e as Error).message), rows: [] as Array<Record<string, any>> }; } };
  const mkUser = async (role: string | null, status = 'active') => (await q<{ id: string }>('insert into users(email,password_hash,full_name,status,platform_role) values($1,$2,$3,$4,$5) returning id', [`d13-${randomUUID()}@example.test`, 'x', 'D13', status, role]))[0]!.id;

  const makeApp = (over: { login?: string; openDbThrows?: boolean } = {}) => {
    const passthrough = createMiddleware(async (_c, next) => next());
    const routes = createStripeReadAdminRoutes({
      limiter: passthrough as never, clock: () => Date.now(),
      openDb: async () => { if (over.openDbThrows) throw new Error('db down'); const c = await connectAs(over.login ?? 'dev13_l_app'); return { db: buildDb(c), close: async () => { await c.end().catch(() => undefined); } }; },
    });
    const app = new Hono<{ Bindings: Bindings }>(); app.onError(errorHandler); app.route('/internal/stripe-read', routes);
    return app;
  };
  const ENV = { ENVIRONMENT: 'development', JWT_ACCESS_SECRET: SECRET, INTERNAL_STRIPE_READ_ADMIN_API: 'enabled', INTERNAL_API_GATEWAY_TOKEN: GATEWAY } as unknown as Bindings;
  const app = makeApp();
  async function session(userId: string, expiresInS = 900) {
    const sid = randomUUID(); const rowId = randomUUID();
    await q("insert into refresh_tokens(id, user_id, token_hash, session_id, expires_at) values($1,$2,$3,$4,now()+interval '1 day')", [rowId, userId, randomUUID(), sid]);
    const auth = `Bearer ${await signAccessToken(userId, SECRET, sid)}`;
    void expiresInS;
    return { auth, sid, rowId };
  }
  const call = (a: Hono<any>, path: string, auth: string | null, init: { method?: string; json?: unknown; headers?: Record<string, string>; env?: Record<string, unknown> } = {}) =>
    a.request(`/internal/stripe-read${path}`, {
      method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
      headers: { 'x-internal-gateway-token': GATEWAY, ...(auth ? { authorization: auth } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    }, { ...ENV, ...(init.env ?? {}) } as Bindings);
  const j = async (r: Response) => r.json() as Promise<any>;
  const policyRow = async () => (await q('select approval_enabled, version from stripe_read_authorization_policy'))[0]!;
  const ownerSet = async (on: boolean) => q('update stripe_read_authorization_policy set approval_enabled = $1', [on]);
  let n = 0;
  const proposalBody = async (over: Record<string, unknown> = {}) => ({ targetState: true, expectedVersion: (await policyRow()).version, justification: `Policy review ${++n}`, expiresAtMs: Date.now() + 3_600_000, ...over });
  /** Proposes as admin 1 and returns what a test needs; cancels any live request first so tuples never collide across tests. */
  async function propose(over: Record<string, unknown> = {}, who = a1) {
    const live = await q("select id from stripe_read_policy_changes where state in ('PENDING','APPROVED')");
    for (const l of live) await tryQ(admin, `update stripe_read_policy_changes set state='CANCELLED', version=version+1, decided_by='${a3}', decision_ref='TEST_CLEANUP', decided_at_ms=0 where id='${l.id}' and state='PENDING'`);
    const approvedLive = await q("select id from stripe_read_policy_changes where state = 'APPROVED' and expected_policy_version = (select version from stripe_read_authorization_policy)");
    if (approvedLive.length) { await ownerSet(true); await ownerSet(false); } // an APPROVED request holds its policy version; the harness, as database owner, moves the version so a fresh scenario can start (the policy value returns to the shipped default)
    const s1 = await session(who); const s2 = await session(a2);
    const r = await call(app, '/policy/changes', s1.auth, { json: await proposalBody(over) }); const out = await j(r);
    if (r.status !== 201) throw new Error('proposal ' + JSON.stringify(out));
    return { s1, s2, id: out.data.changeId as string };
  }
  const ctxFor = async (userId: string, clock: () => number = () => Date.now()): Promise<{ ctx: TrustedAdminContext; rowId: string; svc: PolicyAdministrationService }> => {
    const s = await session(userId); const c = await connectAs('dev13_l_app'); const repos = createRepositories(buildDb(c));
    const deps = { accessSecret: SECRET, users: repos.users, sessions: repos.refreshTokens, clock };
    const out = await authenticateAdminSession(deps, s.auth); if (!out.ok) throw new Error('auth ' + out.reason);
    return { ctx: out.context, rowId: s.rowId, svc: new PolicyAdministrationService(buildDb(c), clock, createSessionRevalidator(deps)) };
  };

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed: ' + m.stderr.slice(0, 400));
    admin = new Client({ connectionString: urlFor(dbName) }); await admin.connect(); clients.push(admin);
    a1 = await mkUser('admin'); a2 = await mkUser('admin'); a3 = await mkUser('admin'); plain = await mkUser(null);
    await q(`CREATE ROLE dev13_l_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO dev13_l_app`);
    await q('GRANT stripe_read_auth_admin, stripe_read_auth_auditor TO dev13_l_app'); await q('GRANT SELECT ON users, refresh_tokens, businesses TO dev13_l_app');
    await q(`CREATE ROLE dev13_l_norole LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO dev13_l_norole`); await q('GRANT SELECT ON users, refresh_tokens, businesses TO dev13_l_norole');
    await q(`CREATE ROLE dev13_l_tenant LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO dev13_l_tenant`); await q('GRANT stripe_read_auth_tenant_reader TO dev13_l_tenant');
    vi.stubGlobal('fetch', async (u: any) => { fetchCalls.push(String(u)); return new Response('{}'); });
  }, 300_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const c of open) await c.end().catch(() => undefined);
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') }); await root.connect();
    await root.query(`drop database if exists ${dbName} with (force)`);
    for (const l of ['dev13_l_app', 'dev13_l_norole', 'dev13_l_tenant']) { try { await root.query(`DROP OWNED BY ${l}`); await root.query(`DROP ROLE IF EXISTS ${l}`); } catch { /* shared cluster */ } }
    await root.end();
  });

  describe('1-8. default-disabled policy, authentication and the happy path', () => {
    it('1. the shipped policy is disabled at version 1, and the API reports it read-only', async () => {
      expect(await policyRow()).toEqual({ approval_enabled: false, version: 1 });
      const s = await session(a1);
      expect((await j(await call(app, '/policy', s.auth))).data).toMatchObject({ approvalEnabled: false, state: 'DISABLED', version: 1, mutableThroughApi: false });
    });

    it('3-6. anonymous, non-administrator, expired and revoked sessions are refused on every policy route', async () => {
      const sp = await session(plain); const s1 = await session(a1); const id = randomUUID(); const exp = Math.floor(Date.now() / 1000) - 3600;
      const { sign } = await import('hono/jwt');
      const expired = `Bearer ${await sign({ sub: a1, sid: s1.sid, type: 'access', iat: exp - 900, exp }, SECRET, 'HS256')}`;
      const routes: Array<[string, string, unknown?]> = [['GET', '/policy'], ['GET', '/policy/changes'], ['GET', '/policy/audit'], ['GET', `/policy/changes/${id}`], ['GET', `/policy/changes/${id}/audit`], ['POST', '/policy/changes', await proposalBody()], ['POST', `/policy/changes/${id}/approve`, { decisionRef: 'E' }], ['POST', `/policy/changes/${id}/reject`, { decisionRef: 'E' }], ['POST', `/policy/changes/${id}/cancel`, { decisionRef: 'E' }]];
      const before = (await q('select (select count(*)::int from stripe_read_policy_changes) c, (select count(*)::int from stripe_read_policy_events) e'))[0]!;
      for (const [m, p, b] of routes) {
        const opts = (b !== undefined ? { method: m, json: b } : { method: m });
        expect((await call(app, p, null, opts)).status, `anon ${m} ${p}`).toBe(401);
        expect((await call(app, p, sp.auth, opts)).status, `non-admin ${m} ${p}`).toBe(403);
        expect((await call(app, p, expired, opts)).status, `expired ${m} ${p}`).toBe(401);
      }
      await q('update refresh_tokens set revoked_at = now() where id = $1', [s1.rowId]);
      for (const [m, p, b] of routes) expect((await call(app, p, s1.auth, b !== undefined ? { method: m, json: b } : { method: m })).status, `revoked ${m} ${p}`).toBe(401);
      expect((await q('select (select count(*)::int from stripe_read_policy_changes) c, (select count(*)::int from stripe_read_policy_events) e'))[0]).toEqual(before);
    });

    it('2, 7, 8, 23. a valid proposal is PENDING and attributed to the session administrator; self-approval is refused; a distinct approver is accepted; the POLICY does not change', async () => {
      const { s1, s2, id } = await propose();
      const row = (await q('select state, version, proposed_by, decided_by, expected_policy_version, target_state from stripe_read_policy_changes where id=$1', [id]))[0]!;
      expect(row).toEqual({ state: 'PENDING', version: 1, proposed_by: a1, decided_by: null, expected_policy_version: (await policyRow()).version, target_state: true });
      const self = await call(app, `/policy/changes/${id}/approve`, s1.auth, { json: { decisionRef: 'SELF-1' } });
      expect([self.status, (await j(self)).error.code]).toEqual([403, 'SELF_DECISION_REFUSED']);
      const forgedBody = await call(app, `/policy/changes/${id}/approve?decidedBy=${a2}`, s1.auth, { json: { decisionRef: 'SELF-2' }, headers: { 'x-admin-user-id': a2 } });
      expect([forgedBody.status, (await j(forgedBody)).error.code]).toEqual([403, 'SELF_DECISION_REFUSED']); // the session's own identity, whatever the request names
      expect((await call(app, `/policy/changes/${id}/approve`, s1.auth, { json: { decisionRef: 'E', decidedBy: a2 } })).status).toBe(422);
      const ok = await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'DECISION-OK-1' } });
      expect([ok.status, (await j(ok)).data]).toEqual([200, expect.objectContaining({ state: 'APPROVED', version: 2, activationPerformed: false })]);
      expect((await q('select decided_by, decision_ref from stripe_read_policy_changes where id=$1', [id]))[0]).toEqual({ decided_by: a2, decision_ref: 'DECISION-OK-1' });
      expect((await policyRow()).approval_enabled).toBe(false); // an APPROVED request never changes the policy
      const status = await j(await call(app, '/policy', s1.auth)); expect(status.data).toMatchObject({ approvalEnabled: false, state: 'DISABLED' });
      const replay = await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'DECISION-OK-1' } });
      expect([replay.status, (await j(replay)).data.version]).toEqual([200, 2]); // an exact replay is idempotent
      const other = await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'DECISION-OTHER' } });
      expect([other.status, (await j(other)).error.code]).toEqual([409, 'POLICY_DECISION_CONFLICT']);
      const rej = await call(app, `/policy/changes/${id}/reject`, s2.auth, { json: { decisionRef: 'DECISION-OK-1' } });
      expect([rej.status, (await j(rej)).error.code]).toEqual([409, 'POLICY_DECISION_CONFLICT']);
      // an approved request must not unlock operational read authorization: the DEV-12 proposal route stays refused, and unapproved methods stay unproposable
      const rp = await call(app, '/authorizations', s1.auth, { json: { businessId: randomUUID(), accountId: 'acct_Dev13Account1', methodId: 'INVOICE_RETRIEVE', realm: 'test', workloadId: 'wl-x', validFromMs: 1, expiresAtMs: Date.now() + 3_600_000, inventoryRevision: 'r' } });
      expect([rp.status, (await j(rp)).error.code]).toEqual([409, 'APPROVAL_POLICY_DISABLED']);
    });
  });

  describe('9-14. expiry, terminal states, duplicates, concurrency and versions', () => {
    it('9. an expired request cannot be approved or rejected, is not listed as pending, and is recorded as EXPIRED only once its time has passed', async () => {
      const { s2, id } = await propose({ expiresAtMs: Date.now() + 1200 });
      const early = await ctxFor(a2); expect(await early.svc.expire(early.ctx, id).catch((e: any) => e.code)).toBe('NOT_EXPIRED');
      await new Promise(r => setTimeout(r, 1400));
      const late = await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'LATE' } }); expect([late.status, (await j(late)).error.code]).toEqual([409, 'POLICY_CHANGE_EXPIRED']);
      const late2 = await call(app, `/policy/changes/${id}/reject`, s2.auth, { json: { decisionRef: 'LATE' } }); expect([late2.status, (await j(late2)).error.code]).toEqual([409, 'POLICY_CHANGE_EXPIRED']);
      const view = await j(await call(app, `/policy/changes/${id}`, s2.auth)); expect(view.data).toMatchObject({ state: 'EXPIRED', storedState: 'PENDING' }); // derived, never silently stored
      const listed = await j(await call(app, '/policy/changes', s2.auth)); expect(listed.data.items.map((i: any) => i.changeId)).not.toContain(id);
      expect(await early.svc.expire(early.ctx, id)).toBe(2);
      expect(await early.svc.expire(early.ctx, id)).toBe(2); // idempotent
      expect((await q('select state, decision_ref from stripe_read_policy_changes where id=$1', [id]))[0]).toEqual({ state: 'EXPIRED', decision_ref: 'EXPIRED' });
      const after = await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'LATE' } }); expect(after.status).toBe(409);
    });

    it('10-11. rejected and cancelled requests can never become approved; a proposer cannot reject their own request but may cancel it', async () => {
      const r = await propose(); const rej = await call(app, `/policy/changes/${r.id}/reject`, r.s1.auth, { json: { decisionRef: 'SELF-REJECT' } });
      expect([rej.status, (await j(rej)).error.code]).toEqual([403, 'SELF_DECISION_REFUSED']);
      expect((await call(app, `/policy/changes/${r.id}/reject`, r.s2.auth, { json: { decisionRef: 'REJECT-1' } })).status).toBe(200);
      const back = await call(app, `/policy/changes/${r.id}/approve`, r.s2.auth, { json: { decisionRef: 'REJECT-1' } }); expect([back.status, (await j(back)).error.code]).toEqual([409, 'POLICY_DECISION_CONFLICT']);
      expect((await tryQ(admin, `update stripe_read_policy_changes set state='APPROVED', version=3, decided_by='${a3}', decision_ref='X', decided_at_ms=0 where id='${r.id}'`)).error).toMatch(/READ_POLICY_TERMINAL/); // and not through SQL either
      const c = await propose(); const cancel = await call(app, `/policy/changes/${c.id}/cancel`, c.s1.auth, { json: { decisionRef: 'CANCEL-1' } });
      expect([cancel.status, (await j(cancel)).data.state]).toEqual([200, 'CANCELLED']);
      expect((await call(app, `/policy/changes/${c.id}/cancel`, c.s1.auth, { json: { decisionRef: 'CANCEL-1' } })).status).toBe(200); // idempotent
      const rev = await call(app, `/policy/changes/${c.id}/approve`, c.s2.auth, { json: { decisionRef: 'CANCEL-1' } }); expect([rev.status, (await j(rev)).error.code]).toEqual([409, 'POLICY_DECISION_CONFLICT']);
      expect((await tryQ(admin, `update stripe_read_policy_changes set state='APPROVED', version=3, decided_by='${a3}', decision_ref='X', decided_at_ms=0 where id='${c.id}'`)).error).toMatch(/READ_POLICY_TERMINAL/);
    });

    it('12. duplicate proposals: one live request per policy version, a repeat is refused, and a new one is possible once the first is no longer live', async () => {
      const first = await propose(); const s1 = first.s1;
      const dup = await call(app, '/policy/changes', s1.auth, { json: await proposalBody() }); expect([dup.status, (await j(dup)).error.code]).toEqual([409, 'DUPLICATE_POLICY_CHANGE']);
      const dup2 = await call(app, '/policy/changes', first.s2.auth, { json: await proposalBody({ targetState: true }) }); expect(dup2.status).toBe(409); // another administrator cannot add a competing one
      await call(app, `/policy/changes/${first.id}/cancel`, s1.auth, { json: { decisionRef: 'CANCEL-DUP' } });
      expect((await call(app, '/policy/changes', s1.auth, { json: await proposalBody() })).status).toBe(201);
      for (const l of await q("select id from stripe_read_policy_changes where state='PENDING'")) await q(`update stripe_read_policy_changes set state='CANCELLED', version=version+1, decided_by='${a3}', decision_ref='CLEAN', decided_at_ms=0 where id='${l.id}'`);
      const ns = await call(app, '/policy/changes', s1.auth, { json: await proposalBody({ targetState: false }) }); expect([ns.status, (await j(ns)).error.code]).toEqual([409, 'POLICY_ALREADY_IN_STATE']); // a no-op target is refused
    });

    it('13. concurrent decisions are race-safe: one decision wins, repeats are idempotent, competing decisions fail deterministically, and the trail has exactly one decision', async () => {
      const { s2, id } = await propose(); const s3 = await session(a3);
      const reqs = [
        ...Array.from({ length: 3 }, () => call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'RACE-APPROVE' } })),
        ...Array.from({ length: 3 }, () => call(app, `/policy/changes/${id}/approve`, s3.auth, { json: { decisionRef: 'RACE-APPROVE-3' } })),
        ...Array.from({ length: 2 }, () => call(app, `/policy/changes/${id}/reject`, s3.auth, { json: { decisionRef: 'RACE-REJECT' } })),
        call(app, `/policy/changes/${id}/cancel`, s3.auth, { json: { decisionRef: 'RACE-CANCEL' } }),
      ];
      const results = await Promise.all(reqs);
      const codes = await Promise.all(results.map(async r => (r.status === 200 ? 'ok' : (await j(r)).error.code)));
      expect(codes.filter(c => c === 'ok').length).toBeGreaterThanOrEqual(1);
      expect(codes.filter(c => c !== 'ok').every(c => c === 'POLICY_DECISION_CONFLICT' || c === 'POLICY_CHANGE_TERMINAL')).toBe(true);
      const final = (await q('select state, version, decision_ref from stripe_read_policy_changes where id=$1', [id]))[0]!;
      expect(final.version).toBe(2); expect(['APPROVED', 'REJECTED', 'CANCELLED']).toContain(final.state);
      expect((await q("select count(*)::int n from stripe_read_policy_events where change_id=$1 and event_type <> 'PROPOSED'", [id]))[0]!.n).toBe(1);
      const all = await call(app, `/policy/changes/${id}`, s2.auth); expect((await j(all)).data.state).toBe(final.state); // one authoritative result
    });

    it('14. policy versions: a stale expected version is refused at proposal and approval, and a changed policy invalidates earlier requests', async () => {
      const s1 = await session(a1); const s2 = await session(a2); const v0 = (await policyRow()).version;
      const stale = await call(app, '/policy/changes', s1.auth, { json: await proposalBody({ expectedVersion: v0 + 90 }) }); expect([stale.status, (await j(stale)).error.code]).toEqual([409, 'POLICY_VERSION_CONFLICT']);
      const zero = await call(app, '/policy/changes', s1.auth, { json: await proposalBody({ expectedVersion: 0 }) }); expect(zero.status).toBe(422);
      const { id } = await propose();
      const vBefore = (await policyRow()).version;
      await ownerSet(true); // the database OWNER (out of band, disposable database) changes the policy: the version advances by exactly one
      expect((await policyRow()).version).toBe(vBefore + 1);
      const late = await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'STALE-APPROVE' } }); expect([late.status, (await j(late)).error.code]).toEqual([409, 'POLICY_VERSION_CONFLICT']);
      expect((await q('select state from stripe_read_policy_changes where id=$1', [id]))[0]!.state).toBe('PENDING');
      expect((await call(app, `/policy/changes/${id}/cancel`, s2.auth, { json: { decisionRef: 'CLEAN-STALE' } })).status).toBe(200);
      const toDisabled = await call(app, '/policy/changes', s1.auth, { json: await proposalBody({ targetState: false }) }); expect(toDisabled.status).toBe(201); // against the NEW version
      expect((await j(await call(app, '/policy/changes', s1.auth, { json: await proposalBody({ expectedVersion: vBefore }) }))).error.code).toBe('POLICY_VERSION_CONFLICT');
      await ownerSet(false); // restore the shipped default
      expect(await policyRow()).toEqual({ approval_enabled: false, version: vBefore + 2 });
      // the version cannot be set directly, only advanced by a change of the value
      await q('update stripe_read_authorization_policy set version = 500'); expect((await policyRow()).version).toBe(vBefore + 2);
      // the out-of-band changes are audited with the database session user and no administrator
      const hist = await j(await call(app, '/policy/audit?limit=100', s1.auth));
      const last2 = hist.data.events.slice(-2);
      expect(last2.map((e: any) => [e.eventType, e.fromState, e.toState, e.policyVersion])).toEqual([['POLICY_VALUE_CHANGED', 'DISABLED', 'ENABLED', vBefore + 1], ['POLICY_VALUE_CHANGED', 'ENABLED', 'DISABLED', vBefore + 2]]);
      const raw = await q("select actor_id, actor_db_role from stripe_read_policy_events where change_id is null order by seq"); expect(raw.every(r => r.actor_id === null && typeof r.actor_db_role === 'string')).toBe(true);
    });
  });

  describe('15-20. storage failure, forged contexts, direct SQL, scope, audit', () => {
    it('15. a store outage, an application login without the DEV-10 roles and a missing policy row all fail closed; none yields a success', async () => {
      const s1 = await session(a1); const s2 = await session(a2);
      const down = await call(makeApp({ openDbThrows: true }), '/policy', s1.auth); expect([down.status, (await j(down)).error.code]).toEqual([500, 'ADMIN_AUTH_UNAVAILABLE']);
      const noRole = makeApp({ login: 'dev13_l_norole' });
      const st = await j(await call(noRole, '/policy', s1.auth)); expect(st.data).toMatchObject({ approvalEnabled: false, state: 'UNKNOWN', version: null });
      const pr = await call(noRole, '/policy/changes', s1.auth, { json: await proposalBody() }); expect([pr.status, (await j(pr)).error.code]).toEqual([500, 'POLICY_STORE_UNAVAILABLE']);
      const ap = await call(noRole, `/policy/changes/${randomUUID()}/approve`, s2.auth, { json: { decisionRef: 'X' } }); expect(ap.status).toBe(500);
      const body = await proposalBody();
      await q('alter table stripe_read_authorization_policy rename to stripe_read_authorization_policy_gone'); // harness: the policy relation is unavailable
      try {
        expect((await j(await call(app, '/policy', s1.auth))).data).toMatchObject({ approvalEnabled: false, state: 'UNKNOWN', version: null });
        const np = await call(app, '/policy/changes', s1.auth, { json: body }); expect(np.status).toBe(500);
        expect((await call(app, `/policy/changes/${randomUUID()}/approve`, s2.auth, { json: { decisionRef: 'X' } })).status).toBeGreaterThanOrEqual(400); // an unavailable store is never a success
      } finally { await q('alter table stripe_read_authorization_policy_gone rename to stripe_read_authorization_policy'); }
      expect((await j(await call(app, '/policy', s1.auth))).data.state).toBe('DISABLED');
    });

    it('16. forged, cloned and stale administrator contexts are refused by the service, and a revoked session loses the service at once', async () => {
      const { ctx, rowId, svc } = await ctxFor(a1); const code = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return e instanceof AdminAuthorityError || e instanceof PolicyAdministrationError ? e.code : String((e as Error).message); } };
      const input = async () => ({ targetState: true, expectedVersion: (await policyRow()).version, justification: 'ctx test', expiresAtMs: Date.now() + 60_000 });
      for (const forged of [{ adminUserId: a2 }, { ...ctx }, structuredClone(ctx), a2, null, undefined]) {
        expect(await code(svc.propose(forged as any, await input())), String(JSON.stringify(forged))).toBe('NOT_A_TRUSTED_CONTEXT');
        expect(await code(svc.decide(forged as any, randomUUID(), 'APPROVE', 'R'))).toBe('NOT_A_TRUSTED_CONTEXT');
        expect(await code(svc.status(forged as any))).toBe('NOT_A_TRUSTED_CONTEXT');
      }
      expect(svc.decide.length).toBe(4); expect(svc.propose.length).toBe(2); // (context, ...): never an actor id
      await q('update refresh_tokens set revoked_at = now() where id = $1', [rowId]);
      const before = (await q('select count(*)::int n from stripe_read_policy_changes'))[0]!.n;
      expect(await code(svc.propose(ctx, await input()))).toBe('SESSION_NOT_LIVE');
      expect(await code(svc.decide(ctx, randomUUID(), 'CANCEL', 'R'))).toBe('SESSION_NOT_LIVE');
      expect(await code(svc.audit(ctx, randomUUID(), { limit: 5, afterSeq: 0 }))).toBe('SESSION_NOT_LIVE');
      expect((await q('select count(*)::int n from stripe_read_policy_changes'))[0]!.n).toBe(before);
      const stale = await ctxFor(a1, () => Date.now()); const later = new PolicyAdministrationService(buildDb(await connectAs('dev13_l_app')), () => Date.now() + 10 * 60_000, async () => 'LIVE');
      expect(await code(later.status(stale.ctx))).toBe('CONTEXT_STALE'); // a context cannot be replayed after its freshness window
      void ctxFor;
    });

    it('17. direct SQL cannot bypass the lifecycle: no DEV-10 role writes the policy, ordinary logins cannot touch the tables, and the guard binds every writer, even the owner with triggers "disabled" by session settings', async () => {
      const { id } = await propose({}, a1); const ordinary = await connectAs('dev13_l_norole'); const app1 = await connectAs('dev13_l_app');
      for (const c of [ordinary, app1]) {
        expect((await tryQ(c, 'update stripe_read_authorization_policy set approval_enabled = true')).error, 'policy value').toMatch(/permission denied/);
        expect((await tryQ(c, 'update stripe_read_authorization_policy set version = 99')).error, 'policy version').toMatch(/permission denied/);
        expect((await tryQ(c, "update stripe_read_policy_changes set state='APPROVED'")).error).toMatch(/permission denied/);
        expect((await tryQ(c, `insert into stripe_read_policy_changes(expected_policy_version,target_state,state,version,justification,proposed_by,expires_at_ms) values(1,true,'APPROVED',1,'x','${a1}',9999999999999)`)).error).toMatch(/permission denied/);
        expect((await tryQ(c, 'delete from stripe_read_policy_changes')).error).toMatch(/permission denied/);
        expect((await tryQ(c, 'truncate stripe_read_policy_changes')).error).toMatch(/permission denied/);
        expect((await tryQ(c, 'truncate stripe_read_policy_events')).error).toMatch(/permission denied/);
      }
      expect((await tryQ(ordinary, `select public.stripe_read_policy_decide('${id}'::uuid, '${a2}'::uuid, 'APPROVE', 'X')`)).error).toMatch(/permission denied/); // only the administrator role may call the functions
      // the functions and the guard still enforce the rules for a caller that HAS the role
      expect((await tryQ(app1, `select public.stripe_read_policy_decide('${id}'::uuid, '${a1}'::uuid, 'APPROVE', 'SELF-SQL')`)).error).toMatch(/READ_POLICY_SELF_DECISION/);
      expect((await tryQ(app1, `select public.stripe_read_policy_decide('${id}'::uuid, '${plain}'::uuid, 'APPROVE', 'PLAIN-SQL')`)).error).toMatch(/READ_POLICY_ADMIN_REQUIRED/);
      expect((await tryQ(app1, `select public.stripe_read_policy_decide('${id}'::uuid, '${randomUUID()}'::uuid, 'APPROVE', 'GHOST-SQL')`)).error).toMatch(/READ_POLICY_ADMIN_REQUIRED|violates foreign key/);
      expect((await tryQ(app1, `select public.stripe_read_policy_propose('${plain}'::uuid, true, 1, 'x', 9999999999999)`)).error).toMatch(/READ_POLICY_ADMIN_REQUIRED/);
      expect((await tryQ(app1, `select public.stripe_read_policy_decide('${id}'::uuid, '${a2}'::uuid, 'ACTIVATE', 'X')`)).error).toMatch(/READ_POLICY_INVALID_TRANSITION/); // there is no activating decision
      const upd = (set: string) => tryQ(admin, `update stripe_read_policy_changes set ${set} where id='${id}'`);
      expect((await upd(`state='APPROVED', version=2, decided_by='${plain}', decision_ref='X', decided_at_ms=0`)).error).toMatch(/READ_POLICY_ADMIN_REQUIRED/);
      expect((await upd(`state='APPROVED', version=2, decided_by='${a1}', decision_ref='X', decided_at_ms=0`)).error).toMatch(/READ_POLICY_SELF_DECISION/);
      expect((await upd(`state='APPROVED', version=7, decided_by='${a2}', decision_ref='X', decided_at_ms=0`)).error).toMatch(/READ_POLICY_VERSION/);
      expect((await upd(`target_state=false, version=2`)).error).toMatch(/READ_POLICY_IMMUTABLE|READ_POLICY_ADMIN_REQUIRED/);
      expect((await upd(`expected_policy_version=9, version=2, decided_by='${a2}'`)).error).toMatch(/READ_POLICY_IMMUTABLE/);
      expect((await upd(`state='EXPIRED', version=2, decided_by='${a2}', decision_ref='EXPIRED', decided_at_ms=0`)).error).toMatch(/READ_POLICY_NOT_EXPIRED/);
      expect((await upd(`state='PENDING', version=2, decided_by='${a2}', decision_ref='X', decided_at_ms=0`)).error).toMatch(/READ_POLICY_INVALID_TRANSITION|fields_check/);
      expect((await tryQ(admin, `insert into stripe_read_policy_changes(expected_policy_version,target_state,state,version,justification,proposed_by,expires_at_ms,decided_by,decided_at_ms,decision_ref) values(1,true,'APPROVED',1,'x','${a1}',9999999999999,'${a2}',1,'X')`)).error).toMatch(/READ_POLICY_INSERT_NOT_PENDING/);
      expect((await tryQ(admin, `delete from stripe_read_policy_changes where id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      const v0 = (await policyRow()).version;
      await admin.query('set session_replication_role = replica'); // a session that tries to skip triggers
      try {
        expect((await upd(`state='APPROVED', version=2, decided_by='${a1}', decision_ref='X', decided_at_ms=0`)).error).toMatch(/READ_POLICY_SELF_DECISION/);
        expect((await tryQ(admin, `delete from stripe_read_policy_changes where id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
        expect((await tryQ(admin, 'update stripe_read_authorization_policy set version = 50')).rows).toEqual([]); // version 50 is overwritten by the trigger below
      } finally { await admin.query('set session_replication_role = origin'); }
      expect((await policyRow()).version).toBe(v0); // the version cannot be set directly: only a change of the value advances it, by exactly one
      expect((await q('select state from stripe_read_policy_changes where id=$1', [id]))[0]!.state).toBe('PENDING');
    });

    it('18. scope: tenant and ordinary logins cannot read policy administration data, and business-level users have no administrator access to it', async () => {
      await propose();
      const tenant = await connectAs('dev13_l_tenant'); await tenant.query(`select set_config('echogrid.tenant_id', $1, false)`, [randomUUID()]);
      for (const table of ['stripe_read_policy_changes', 'stripe_read_policy_events', 'stripe_read_authorization_policy']) expect((await tryQ(tenant, `select count(*) from ${table}`)).error, table).toMatch(/permission denied/);
      const ordinary = await connectAs('dev13_l_norole');
      for (const table of ['stripe_read_policy_changes', 'stripe_read_policy_events']) expect((await tryQ(ordinary, `select count(*) from ${table}`)).error, table).toMatch(/permission denied/);
      const sp = await session(plain);
      for (const path of ['/policy', '/policy/changes', '/policy/audit']) expect((await call(app, path, sp.auth)).status, path).toBe(403);
      // RLS is forced on the new tables, and the roles that exist for them are safe
      expect((await q("select relname, relrowsecurity r, relforcerowsecurity f from pg_class where relname in ('stripe_read_policy_changes','stripe_read_policy_events') order by 1")).map(r => [r.r, r.f])).toEqual([[true, true], [true, true]]);
      const fns = await q("select p.proname, pg_get_userbyid(p.proowner) owner, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') pub from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'stripe_read_policy%'");
      expect(fns.length).toBe(9);
      for (const f of fns) { expect(f.pub, `${f.proname} PUBLIC execute`).toBe(false); if (f.prosecdef) { expect(f.owner, f.proname).toBe('stripe_read_auth_lifecycle'); expect(String(f.proconfig), f.proname).toMatch(/search_path=/); } }
    });

    it('19-20. the policy audit trail is complete, attributable, immutable and ordered; pagination is bounded and deterministic', async () => {
      const { s1, s2, id } = await propose();
      await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'AUDIT-APPROVE' } });
      const events = await q('select seq, version, event_type, from_state, to_state, actor_id, decision_ref, policy_version, record_digest from stripe_read_policy_events where change_id=$1 order by seq', [id]);
      expect(events.map(e => [e.version, e.event_type, e.from_state, e.to_state, e.actor_id])).toEqual([[1, 'PROPOSED', null, 'PENDING', a1], [2, 'APPROVED', 'PENDING', 'APPROVED', a2]]);
      expect(new Set(events.map(e => e.record_digest)).size).toBe(2); expect(events.every(e => /^[0-9a-f]{64}$/.test(e.record_digest))).toBe(true);
      expect(events[0]!.seq < events[1]!.seq).toBe(true);
      expect((await tryQ(admin, `update stripe_read_policy_events set actor_id='${a3}' where change_id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, `delete from stripe_read_policy_events where change_id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, 'truncate stripe_read_policy_events')).error).not.toBe('');
      expect((await tryQ(admin, 'truncate stripe_read_policy_changes cascade')).error).not.toBe('');
      const app1 = await connectAs('dev13_l_app');
      expect((await tryQ(app1, `update stripe_read_policy_events set actor_id='${a3}'`)).error).toMatch(/permission denied/);
      expect((await tryQ(app1, 'delete from stripe_read_policy_events')).error).toMatch(/permission denied/);
      const full = await j(await call(app, `/policy/changes/${id}/audit`, s1.auth));
      expect(full.data.events.map((e: any) => [e.version, e.eventType])).toEqual([[1, 'PROPOSED'], [2, 'APPROVED']]);
      const page1 = await j(await call(app, `/policy/changes/${id}/audit?limit=1`, s1.auth)); expect(page1.data.events).toHaveLength(1); expect(page1.data.nextAfterSeq).toBe(page1.data.events[0].seq);
      const page2 = await j(await call(app, `/policy/changes/${id}/audit?limit=1&afterSeq=${page1.data.nextAfterSeq}`, s1.auth)); expect(page2.data.events.map((e: any) => e.version)).toEqual([2]); expect(page2.data.nextAfterSeq).toBeNull();
      for (const bad of ['limit=0', 'limit=101', 'limit=x', 'afterSeq=-1', 'extra=1']) expect((await call(app, `/policy/changes/${id}/audit?${bad}`, s1.auth)).status, bad).toBe(422);
      expect(full.data.events[0].actorRef).not.toBe(full.data.events[1].actorRef); expect(JSON.stringify(full)).not.toContain(a1); expect(JSON.stringify(full)).not.toContain(a2);
      expect((await call(app, `/policy/changes/${randomUUID()}/audit`, s1.auth)).status).toBe(404);
      // pending list: deterministic order by database sequence, bounded
      for (const l of await q("select id from stripe_read_policy_changes where state='PENDING'")) await q(`update stripe_read_policy_changes set state='CANCELLED', version=version+1, decided_by='${a3}', decision_ref='CLEAN', decided_at_ms=0 where id='${l.id}'`);
      const list = await j(await call(app, '/policy/changes?limit=1', s1.auth)); expect(list.data.items).toHaveLength(0); expect(list.data.nextAfterSeq).toBeNull();
    });

    it('21-27. nothing activates anything: no HTTP route or environment value sets the policy, an approved request leaves it disabled, restricted methods stay closed, and no Stripe request or ledger movement ever happens', async () => {
      const ledger = async () => (await q("select (select count(*)::int from partner_credit_ledger) l, (select count(*)::int from partner_credit_settlement_authorizations) s, (select count(*)::int from partner_credit_lots) lots"))[0]!;
      const before = await ledger(); fetchCalls.length = 0;
      const { s1, s2, id } = await propose(); const v0 = (await policyRow()).version;
      for (const [m, path] of [['POST', '/policy'], ['PUT', '/policy'], ['PATCH', '/policy'], ['POST', '/policy/activate'], ['POST', '/policy/enable'], ['POST', `/policy/changes/${id}/activate`], ['POST', `/policy/changes/${id}/apply`], ['PUT', `/policy/changes/${id}`], ['DELETE', `/policy/changes/${id}`]] as const)
        expect((await call(app, path, s1.auth, { method: m, json: { approvalEnabled: true, enabled: true, targetState: true } })).status, `${m} ${path}`).toBe(404);
      process.env.APPROVAL_ENABLED = 'true'; process.env.STRIPE_READ_APPROVAL_ENABLED = 'true';
      try {
        const flagged = await call(app, '/policy', s1.auth, { env: { APPROVAL_ENABLED: 'true', STRIPE_READ_APPROVAL_ENABLED: 'true', INTERNAL_APPROVAL_ENABLED: 'true' } });
        expect((await j(flagged)).data).toMatchObject({ approvalEnabled: false, state: 'DISABLED' });
        await call(app, `/policy/changes/${id}/approve`, s2.auth, { json: { decisionRef: 'NO-ACTIVATION' }, env: { APPROVAL_ENABLED: 'true' } });
      } finally { delete process.env.APPROVAL_ENABLED; delete process.env.STRIPE_READ_APPROVAL_ENABLED; }
      expect((await q('select state from stripe_read_policy_changes where id=$1', [id]))[0]!.state).toBe('APPROVED');
      expect((await policyRow()).approval_enabled).toBe(false); expect((await policyRow()).version).toBe(v0); // 22-23: an approved request, with environment flags set, still leaves the policy disabled and unchanged
      const rp = await call(app, '/authorizations', s1.auth, { json: { businessId: randomUUID(), accountId: 'acct_Dev13Account1', methodId: 'INVOICE_RETRIEVE', realm: 'test', workloadId: 'wl-x', validFromMs: 1, expiresAtMs: Date.now() + 3_600_000, inventoryRevision: 'r' } });
      expect([rp.status, (await j(rp)).error.code]).toEqual([409, 'APPROVAL_POLICY_DISABLED']);
      // 24: even with the policy value set by the OWNER fixture, restricted read methods are not proposable and no workload is provisioned
      await ownerSet(true);
      try {
        for (const m of ['REFUNDS_LIST', 'PAYMENT_RETRIEVE', 'INVOICE_LINES_LIST', 'DISPUTES_LIST']) expect((await call(app, '/authorizations', s1.auth, { json: { businessId: randomUUID(), accountId: 'acct_Dev13Account1', methodId: m, realm: 'test', workloadId: 'wl-x', validFromMs: 1, expiresAtMs: Date.now() + 3_600_000, inventoryRevision: 'r' } })).status, m).toBe(422);
        expect((await j(await call(app, '/policy', s1.auth))).data).toMatchObject({ approvalEnabled: true, state: 'ENABLED', version: v0 + 1, mutableThroughApi: false });
      } finally { await ownerSet(false); }
      expect(fetchCalls).toEqual([]); // 25-26: no Stripe request of any kind, so no write
      expect(await ledger()).toEqual(before); // 27: no ledger, settlement or lot movement
    });
  });
});
