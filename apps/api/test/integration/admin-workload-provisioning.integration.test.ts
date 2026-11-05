/* eslint-disable @typescript-eslint/no-explicit-any -- tests build forged objects and drive raw SQL deliberately */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign as nodeSign } from 'node:crypto';
import { resolve } from 'node:path';
import { buildDb } from '../../src/db/client';
import { createRepositories } from '../../src/repositories';
import { signAccessToken, verifyAccessToken } from '../../src/auth/jwt';
import { AuthService } from '../../src/auth/auth.service';
import { createDirectPbkdf2Worker } from '../../src/auth/pbkdf2-worker';
import {
  authenticateAdminSession, createSessionRevalidator, ReadAuthorizationAdminService, createDurableAuthorizationStore, createWorkloadAuthority, gateForWorkload, createCredentialCustody,
  createSigningCustody, createObservationVerifier, createTrustedStripeRuntime, checkRead, MappingRegistry, AdminAuthorityError, type TrustedAdminContext,
} from '../../src/billing/stripe-read';
import { ReadAuthorizationLifecycleError } from '../../src/billing/stripe-read/durable-authorization';
import { ReadAuthorizationLifecycle } from '../../src/billing/stripe-read/durable-authorization';
import { createSyntheticTrustedRuntime } from '../../src/billing/stripe-read/synthetic-runtime';
import { captureProof } from '../../src/billing/stripe-read/proof-capture';
import { createInMemoryProofStore } from '../../src/billing/stripe-read';
import { syntheticTrust } from '../../src/billing/stripe-read/pipeline-fixtures';

/**
 * S08-D1D3-DEV-11 on PostgreSQL, in a SCRATCH database: the administrator session boundary over the REAL users and refresh_tokens records, the authorization lifecycle service over the DEV-10 durable
 * store (policy disabled by default), and the trusted workload / credential / signing boundaries wired to the durable authorization gate. No Stripe, provider, Neon or production resource: the one fetch
 * the real runtime could make is a stub that records calls.
 */
describe.skipIf(!process.env.DATABASE_URL)('D1/D3-DEV-11 administrator authority and workload provisioning (integration, scratch database)', () => {
  const base = new URL(process.env.DATABASE_URL!);
  const api = resolve(__dirname, '../..');
  const dbName = `echogrid_s08_d11_${randomBytes(4).toString('hex')}`;
  const urlFor = (name: string) => { const u = new URL(base.toString()); u.pathname = `/${name}`; return u.toString(); };
  const PW = 'dev11-' + randomBytes(6).toString('hex');
  const SECRET = 'dev11-integration-secret-0123456789abcdef';
  const clients: Client[] = [];
  let admin: Client;
  const connect = async () => { const c = new Client({ connectionString: urlFor(dbName) }); await c.connect(); clients.push(c); return c; };
  const connectAs = async (login: string) => { const u = new URL(urlFor(dbName)); u.username = login; u.password = PW; const c = new Client({ connectionString: u.toString() }); await c.connect(); clients.push(c); return c; };
  const q = async <T extends Record<string, any> = Record<string, any>>(text: string, params: unknown[] = []) => (await admin.query<T>(text, params)).rows;
  const tryQ = async (c: Client, text: string, params: unknown[] = []) => { try { return { error: '', rows: (await c.query(text, params)).rows as Array<Record<string, any>> }; } catch (e) { return { error: String((e as Error).message), rows: [] as Array<Record<string, any>> }; } };
  const code = async (p: Promise<unknown>) => { try { await p; return ''; } catch (e) { return e instanceof ReadAuthorizationLifecycleError || e instanceof AdminAuthorityError ? e.code : String((e as Error).message); } };

  const WORKLOAD = 'wl-d11-verifier'; const ACCT = 'acct_Dev11Account1'; let biz: string;
  const GOOD_KEY = ['rk', 'test', 'Dev11IntegrationCredential01'].join('_');
  let a1: { id: string }; let a2: { id: string }; let plain: string;

  /** A real session: a refresh_tokens row carrying a session id, plus the session-bound access token the AuthService issues for it. */
  const sessionOf = new Map<string, { sid: string; rowId: string; userId: string }>();
  async function login(userId: string, over: { revoked?: boolean } = {}) {
    const sid = randomUUID(); const rowId = randomUUID();
    await q('insert into refresh_tokens(id, user_id, token_hash, session_id, expires_at, revoked_at) values($1,$2,$3,$4,now()+interval \'1 day\',$5)', [rowId, userId, randomUUID(), sid, over.revoked ? new Date() : null]);
    const header = `Bearer ${await signAccessToken(userId, SECRET, sid)}`;
    sessionOf.set(header, { sid, rowId, userId });
    return header;
  }
  const appRepos = async () => createRepositories(buildDb(await connect()));
  const depsFor = async (clock: () => number = () => Date.now()) => { const repos = await appRepos(); return { accessSecret: SECRET, users: repos.users, sessions: repos.refreshTokens, clock }; };
  async function contextFor(userId: string, clock: () => number = () => Date.now()): Promise<TrustedAdminContext> {
    const out = await authenticateAdminSession(await depsFor(clock), await login(userId));
    if (!out.ok) throw new Error('auth ' + out.reason);
    return out.context;
  }
  /** A context together with the session it came from, so a test can revoke exactly that session. */
  async function sessionContext(userId: string) {
    const header = await login(userId); const out = await authenticateAdminSession(await depsFor(), header);
    if (!out.ok) throw new Error('auth ' + out.reason);
    return { ctx: out.context, ...sessionOf.get(header)!, header };
  }
  const serviceFor = async (login = 'dev11_l_admin', maxAge?: number) => new ReadAuthorizationAdminService(buildDb(await connectAs(login)), () => Date.now(), createSessionRevalidator(await depsFor()), maxAge);
  const input = (over: Record<string, unknown> = {}) => ({ businessId: biz, accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE' as const, validFromMs: 1, expiresAtMs: Date.now() + 3_600_000, inventoryRecordId: 'S08-STRIPE-PRIVATE-TEST-VERIFIER-001', inventoryRevision: 'rev-1', ...over });
  let n = 0; const acct = () => `acct_Dev11U${++n}x`;

  beforeAll(async () => {
    const root = new Client({ connectionString: urlFor('postgres') });
    await root.connect(); await root.query(`create database ${dbName}`); await root.end();
    const m = spawnSync(process.execPath, [resolve(api, 'node_modules/drizzle-kit/bin.cjs'), 'migrate'], { cwd: api, encoding: 'utf8', timeout: 240_000, env: { ...process.env, DATABASE_URL: urlFor(dbName) } });
    if (m.status !== 0) throw new Error('scratch migrate failed: ' + m.stderr.slice(0, 400));
    admin = await connect();
    biz = (await q<{ id: string }>("insert into businesses(name,slug,status) values('D11','d11-"+dbName+"','active') returning id"))[0]!.id;
    const mk = async (role: string | null, status = 'active') => (await q<{ id: string }>('insert into users(email,password_hash,full_name,status,platform_role) values($1,$2,$3,$4,$5) returning id', [`d11-${randomUUID()}@example.test`, 'x', 'D11', status, role]))[0]!;
    a1 = await mk('admin'); a2 = await mk('admin'); plain = (await mk(null)).id;
    for (const [l, member] of [['dev11_l_admin', 'stripe_read_auth_admin'], ['dev11_l_verifier', 'stripe_read_auth_verifier'], ['dev11_l_app', null]] as const) {
      await q(`CREATE ROLE ${l} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${PW}'`); await q(`GRANT CONNECT ON DATABASE ${dbName} TO ${l}`);
      if (member) await q(`GRANT ${member} TO ${l}`);
    }
    await q('GRANT stripe_read_auth_auditor TO dev11_l_admin'); // the service reads status and history as the auditor role (a login holding both roles, as a real admin service would)
    await q('GRANT ALL ON ALL TABLES IN SCHEMA public TO dev11_l_app');
  }, 300_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => undefined);
    const root = new Client({ connectionString: urlFor('postgres') }); await root.connect();
    await root.query(`drop database if exists ${dbName} with (force)`);
    for (const l of ['dev11_l_admin', 'dev11_l_verifier', 'dev11_l_app']) { try { await root.query(`DROP OWNED BY ${l}`); await root.query(`DROP ROLE IF EXISTS ${l}`); } catch { /* shared cluster */ } }
    await root.end();
  });

  describe('11-20. authorization lifecycle through the administrator service', () => {
    it('20. the operational policy is DISABLED by default: a proposal exists, approval is refused, and the read gate therefore denies retrieval', async () => {
      const ctx1 = await contextFor(a1.id); const ctx2 = await contextFor(a2.id); const svc = await serviceFor();
      const acc = acct();
      const id = await svc.propose(ctx1, input({ accountId: acc }));
      expect(await code(svc.approve(ctx2, id, 'EVIDENCE-DISABLED'))).toBe('APPROVAL_DISABLED');
      expect((await svc.status(ctx1, id))).toMatchObject({ state: 'PENDING', version: 1, proposedBy: a1.id, approvedBy: null });
      const store = createDurableAuthorizationStore(buildDb(await connectAs('dev11_l_verifier')));
      const gate = { store, workloadId: WORKLOAD, mapping: MappingRegistry.catalog() };
      expect(await checkRead(gate as any, { businessId: biz, accountId: acc, methodId: 'INVOICE_RETRIEVE', apiVersion: '2026-05-27.dahlia', purpose: 'PROOF' }, Date.now())).toEqual({ ok: false, reason: 'AUTHORIZATION_NOT_APPROVED' }); // 6: a pending authorization cannot be used
      // the real runtime makes no request: the stubbed platform fetch is never called
      const calls: string[] = []; vi.stubGlobal('fetch', async (u: any) => { calls.push(String(u)); return new Response('{}'); });
      const trust = syntheticTrust('TRUSTED_RUNTIME');
      const runtime = createTrustedStripeRuntime({ signer: trust.signer, keyRing: trust.keyRing, gate: gate as any, credentials: { async resolve() { return { apiKey: GOOD_KEY, accountId: acc, workloadId: WORKLOAD, validUntilMs: Date.now() + 60_000 }; } }, clock: () => Date.now() });
      expect(await runtime.read({ businessId: biz, accountId: acc, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1', apiVersion: '2026-05-27.dahlia', purpose: 'PROOF' })).toEqual({ ok: false, kind: 'DENIED', reason: 'AUTHORIZATION_NOT_APPROVED' });
      expect(calls).toEqual([]); vi.unstubAllGlobals();
      await q('update stripe_read_authorization_policy set approval_enabled = true'); // the owner-side switch, flipped only in this disposable database
    });

    it('11-13. an authorized proposal and approval succeed with actors derived from the sessions; self-approval and caller-supplied identities are impossible', async () => {
      const ctx1 = await contextFor(a1.id); const ctx2 = await contextFor(a2.id); const svc = await serviceFor();
      const id = await svc.propose(ctx1, input({ accountId: acct() }));
      expect(await code(svc.approve(ctx1, id, 'SELF'))).toBe('SELF_APPROVAL'); // 13: the proposer and the approver must be distinct
      expect((await svc.status(ctx2, id))!.state).toBe('PENDING');
      expect(await svc.approve(ctx2, id, 'EVIDENCE-OK')).toBe(2);
      expect(await svc.status(ctx1, id)).toMatchObject({ state: 'APPROVED', version: 2, proposedBy: a1.id, approvedBy: a2.id });
      expect(await svc.approve(ctx2, id, 'EVIDENCE-OK')).toBe(2); // an exact repeat is idempotent
      // no actor parameter exists: a forged or cloned context, or a bare id, is refused before the database
      for (const forged of [{ adminUserId: a2.id }, { ...ctx2 }, structuredClone(ctx2), a2.id, null, undefined]) {
        expect(await code(svc.approve(forged as any, id, 'X')), String(JSON.stringify(forged))).toBe('NOT_A_TRUSTED_CONTEXT');
        expect(await code(svc.propose(forged as any, input({ accountId: acct() })))).toBe('NOT_A_TRUSTED_CONTEXT');
        expect(await code(svc.revoke(forged as any, id, 'X'))).toBe('NOT_A_TRUSTED_CONTEXT');
      }
      expect(svc.approve.length).toBe(3); expect(svc.propose.length).toBe(2); // (context, ...): never an actor id
      // a stale context cannot be replayed
      const stale = await serviceFor('dev11_l_admin', 1);
      await new Promise(r => setTimeout(r, 20));
      expect(await code(stale.revoke(ctx1, id, 'LATE'))).toBe('CONTEXT_STALE');
      // an administrator demoted after the context was minted is stopped by the DATABASE guard (defence in depth)
      const demoted = (await q<{ id: string }>("insert into users(email,password_hash,full_name,status,platform_role) values($1,'x','D','active','admin') returning id", [`d11-${randomUUID()}@example.test`]))[0]!.id;
      const dctx = await contextFor(demoted); await q("update users set platform_role = null where id = $1", [demoted]);
      expect(await code(svc.propose(dctx, input({ accountId: acct() })))).toBe('SESSION_NOT_LIVE'); // re-verified at use against the persisted role
      // and the DATABASE refuses the demoted administrator independently of the application layer
      expect(await code(new ReadAuthorizationLifecycle(buildDb(await connectAs('dev11_l_admin'))).propose(input({ accountId: acct() }), demoted))).toBe('ADMIN_REQUIRED');
    });

    it('14-15. a revoked authorization cannot be restored and an expired one cannot become active; renewal is a new, explicitly approved authorization', async () => {
      const c1 = await contextFor(a1.id); const c2 = await contextFor(a2.id); const svc = await serviceFor();
      const id = await svc.propose(c1, input({ accountId: acct() })); await svc.approve(c2, id, 'EV-R');
      expect(await svc.revoke(c1, id, 'OWNER_REQUEST')).toBe(3);
      expect(await code(svc.approve(c2, id, 'EV-AGAIN'))).toBe('REVOKED_TERMINAL');
      expect(await code(svc.approve(c2, id, 'EV-R'))).toBe('REVOKED_TERMINAL'); // even the exact original approval cannot be replayed
      expect(await svc.revoke(c2, id, 'OTHER_ADMIN')).toBe(3); // revocation is idempotent
      expect(await svc.status(c1, id)).toMatchObject({ state: 'REVOKED', version: 3, revokedBy: a1.id });
      const soon = await svc.propose(c1, input({ accountId: acct(), expiresAtMs: Date.now() + 1200 }));
      await new Promise(r => setTimeout(r, 1400));
      expect(await code(svc.approve(c2, soon, 'EV-LATE'))).toBe('EXPIRED');
      expect((await svc.status(c1, soon))!.state).toBe('PENDING');
    });

    it('16-17. concurrent approvals are race-safe (one winner, one audit event) and concurrent revocations are idempotent and durable', async () => {
      const c1 = await contextFor(a1.id); const c2 = await contextFor(a2.id); const svc = await serviceFor();
      const id = await svc.propose(c1, input({ accountId: acct() }));
      const svcs = await Promise.all(Array.from({ length: 6 }, () => serviceFor()));
      const out = await Promise.all(svcs.map((s, i) => s.approve(c2, id, `EV-${i % 3}`).then(() => 'ok', (e: any) => e.code as string)));
      expect(out.filter(x => x === 'ok').length).toBeGreaterThanOrEqual(1);
      expect(out.filter(x => x !== 'ok').every(x => x === 'ALREADY_APPROVED')).toBe(true);
      const history = await svc.auditHistory(c1, id);
      expect(history.filter(h => h.eventType === 'APPROVED')).toHaveLength(1);
      const versions = await Promise.all(svcs.map(s => s.revoke(c1, id, 'RACE')));
      expect(new Set(versions).size).toBe(1); expect((await svc.status(c2, id))!.state).toBe('REVOKED');
      expect((await svc.auditHistory(c1, id)).filter(h => h.eventType === 'REVOKED')).toHaveLength(1);
    });

    it('18-19. direct SQL cannot bypass the lifecycle and the audit history is immutable and attributes every change to the session administrators', async () => {
      const c1 = await contextFor(a1.id); const c2 = await contextFor(a2.id); const svc = await serviceFor();
      const id = await svc.propose(c1, input({ accountId: acct() })); await svc.approve(c2, id, 'EV-A'); await svc.revoke(c1, id, 'DONE');
      const app = await connectAs('dev11_l_app');
      expect((await tryQ(app, "insert into stripe_read_authorizations(business_id,account_id,realm,workload_id,method_id,state,valid_from_ms,expires_at_ms,inventory_record_id,inventory_revision,proposed_by) values($1,'acct_Dev11Sql1','test',$2,'INVOICE_RETRIEVE','APPROVED',1,9999999999999,'X','r',$3)", [biz, WORKLOAD, a1.id])).error).not.toBe('');
      expect((await tryQ(app, `select public.stripe_read_auth_approve('${id}'::uuid, '${a2.id}'::uuid, 'X')`)).error).toMatch(/permission denied/);
      expect((await tryQ(admin, `update stripe_read_authorizations set state='APPROVED', version=4 where id='${id}'`)).error).toMatch(/READ_AUTH_REVOKED_TERMINAL/);
      const fresh = await svc.propose(c1, input({ accountId: acct() }));
      expect((await tryQ(admin, `update stripe_read_authorizations set state='APPROVED', version=2, approved_by='${plain}', approval_evidence_ref='E', approved_at_ms=0 where id='${fresh}'`)).error).toMatch(/READ_AUTH_ADMIN_REQUIRED/);
      expect((await tryQ(admin, `update stripe_read_authorizations set state='APPROVED', version=2, approved_by='${a1.id}', approval_evidence_ref='E', approved_at_ms=0 where id='${fresh}'`)).error).toMatch(/READ_AUTH_SELF_APPROVAL/);
      const h = await svc.auditHistory(c1, id);
      expect(h.map(x => [x.version, x.eventType, x.actorId])).toEqual([[1, 'PROPOSED', a1.id], [2, 'APPROVED', a2.id], [3, 'REVOKED', a1.id]]);
      expect(new Set(h.map(x => x.recordDigest)).size).toBe(3);
      expect((await tryQ(admin, `update stripe_read_authorization_events set actor_id='${a2.id}' where authorization_id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect((await tryQ(admin, `delete from stripe_read_authorization_events where authorization_id='${id}'`)).error).toMatch(/READ_AUTH_APPEND_ONLY/);
      expect(await code(svc.status(c1, 'not-a-uuid'))).toBe('INVALID_INPUT'); expect(await svc.status(c1, randomUUID())).toBeNull();
    });
  });

  describe('R1. session-specific revocation over PostgreSQL', () => {
    it('the real AuthService issues session-bound tokens: login creates a session, refresh keeps it, logout and revocation end it, and the persisted refresh_tokens rows say so', async () => {
      const repos = await appRepos();
      const auth = new AuthService(repos, { JWT_ACCESS_SECRET: SECRET, JWT_REFRESH_SECRET: 'r1-refresh-secret-0123456789abcdef-cccc' }, createDirectPbkdf2Worker());
      const email = `r1-${randomUUID()}@example.test`;
      const signed = await auth.signup({ email, password: 'correct horse battery staple', fullName: 'R1 Admin' });
      const uid = (await q<{ id: string }>('select id from users where email = $1', [email]))[0]!.id;
      await q("update users set platform_role = 'admin' where id = $1", [uid]);
      const t1 = await auth.login({ email, password: 'correct horse battery staple' });
      const sid = (await verifyAccessToken(t1.accessToken, SECRET)).sid!;
      expect(sid).toMatch(/^[0-9a-f-]{36}$/);
      const rowsOf = async (s: string) => q<{ revoked_at: Date | null }>('select revoked_at from refresh_tokens where user_id = $1 and session_id = $2 order by issued_at', [uid, s]);
      expect(await rowsOf(sid)).toHaveLength(1);
      expect((await authenticateAdminSession(await depsFor(), `Bearer ${t1.accessToken}`)).ok).toBe(true);
      const t2 = await auth.refresh(t1.refreshToken); // the session survives its own rotation
      expect((await verifyAccessToken(t2.accessToken, SECRET)).sid).toBe(sid);
      const rows = await rowsOf(sid); expect(rows).toHaveLength(2); expect(rows.filter(r => r.revoked_at === null)).toHaveLength(1);
      expect((await authenticateAdminSession(await depsFor(), `Bearer ${t2.accessToken}`)).ok).toBe(true);
      // signup's session and this login's session are different sessions of one user
      const signedSid = (await verifyAccessToken(signed.accessToken, SECRET)).sid!; expect(signedSid).not.toBe(sid);
      await auth.logout(t2.refreshToken);
      expect(await authenticateAdminSession(await depsFor(), `Bearer ${t2.accessToken}`)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      expect(await authenticateAdminSession(await depsFor(), `Bearer ${t1.accessToken}`)).toEqual({ ok: false, reason: 'SESSION_REVOKED' }); // every token of the session
      expect((await authenticateAdminSession(await depsFor(), `Bearer ${signed.accessToken}`)).ok).toBe(true); // the sibling session is a different session
      expect(await rowsOf(sid)).toSatisfy((r: Array<{ revoked_at: Date | null }>) => r.every(x => x.revoked_at !== null));
      // replay containment kills every session
      const t3 = await auth.login({ email, password: 'correct horse battery staple' }); const t4 = await auth.refresh(t3.refreshToken);
      await q("update refresh_tokens set revoked_at = now() - interval '5 minutes' where user_id = $1 and session_id = $2 and replaced_by_token_id is not null", [uid, (await verifyAccessToken(t3.accessToken, SECRET)).sid]);
      await expect(auth.refresh(t3.refreshToken)).rejects.toThrow();
      expect(await authenticateAdminSession(await depsFor(), `Bearer ${t4.accessToken}`)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      expect(await authenticateAdminSession(await depsFor(), `Bearer ${signed.accessToken}`)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      // a legacy row (no session id) is not an administrative session, and gets one only at its next refresh
      const legacyEmail = `r1-${randomUUID()}@example.test`;
      const lt = await auth.signup({ email: legacyEmail, password: 'correct horse battery staple', fullName: 'Legacy' });
      const luid = (await q<{ id: string }>('select id from users where email = $1', [legacyEmail]))[0]!.id; await q("update users set platform_role = 'admin' where id = $1", [luid]);
      await q('update refresh_tokens set session_id = null where user_id = $1', [luid]);
      expect(await authenticateAdminSession(await depsFor(), `Bearer ${lt.accessToken}`)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      expect(await authenticateAdminSession(await depsFor(), `Bearer ${await signAccessToken(luid, SECRET)}`)).toEqual({ ok: false, reason: 'SESSION_BINDING_MISSING' });
      const lt2 = await auth.refresh(lt.refreshToken); expect((await authenticateAdminSession(await depsFor(), `Bearer ${lt2.accessToken}`)).ok).toBe(true);
    }, 60_000);

    it('the repository answers per exact session: another user, another session, a revoked row and an expired row never validate', async () => {
      const repos = await appRepos(); const now = Date.now();
      const s1 = randomUUID(); const s2 = randomUUID();
      const mk = (uid: string, sid: string, over: string) => q(`insert into refresh_tokens(user_id, token_hash, session_id, expires_at, revoked_at) values($1,$2,$3,${over})`, [uid, randomUUID(), sid]);
      await mk(a1.id, s1, "now()+interval '1 day', null"); await mk(a1.id, s2, 'now()-interval \'1 minute\', null'); await mk(a2.id, randomUUID(), "now()+interval '1 day', now()");
      expect(await repos.refreshTokens.isSessionLive(a1.id, s1, now)).toBe(true);
      expect(await repos.refreshTokens.isSessionLive(a2.id, s1, now)).toBe(false); // another user's id with this session id
      expect(await repos.refreshTokens.isSessionLive(a1.id, s2, now)).toBe(false); // expired
      expect(await repos.refreshTokens.isSessionLive(a1.id, randomUUID(), now)).toBe(false);
      expect(await repos.refreshTokens.revokeSession(a2.id, s1)).toBe(0); // another user cannot end this session by naming its id
      expect(await repos.refreshTokens.isSessionLive(a1.id, s1, now)).toBe(true);
      expect(await repos.refreshTokens.revokeSession(a1.id, s1)).toBe(1);
      expect(await repos.refreshTokens.isSessionLive(a1.id, s1, now)).toBe(false);
      expect(await repos.refreshTokens.revokeSession(a1.id, s1)).toBe(0); // idempotent
    });

    it('15-18. a revoked session cannot propose, approve, revoke, read status or read audit history; another live session of the same administrator does not help; nothing changes in the database', async () => {
      const svc = await serviceFor();
      const s1 = await sessionContext(a1.id); const s1b = await sessionContext(a1.id); const s2 = await sessionContext(a2.id);
      const id = await svc.propose(s1.ctx, input({ accountId: acct() }));
      await q('update refresh_tokens set revoked_at = now() where id = $1', [s1.rowId]); // revoke ONLY the first session
      const before = (await q('select (select count(*)::int from stripe_read_authorizations) a, (select count(*)::int from stripe_read_authorization_events) e'))[0]!;
      expect(await code(svc.propose(s1.ctx, input({ accountId: acct() })))).toBe('SESSION_NOT_LIVE'); // 15
      expect(await code(svc.revoke(s1.ctx, id, 'REVOKED_SESSION'))).toBe('SESSION_NOT_LIVE'); // 17
      expect(await code(svc.status(s1.ctx, id))).toBe('SESSION_NOT_LIVE');
      expect(await code(svc.auditHistory(s1.ctx, id))).toBe('SESSION_NOT_LIVE'); // 18
      expect((await q('select (select count(*)::int from stripe_read_authorizations) a, (select count(*)::int from stripe_read_authorization_events) e'))[0]).toEqual(before);
      expect((await svc.status(s1b.ctx, id))!.state).toBe('PENDING'); // the same administrator's other live session works
      expect(await svc.approve(s2.ctx, id, 'EV-R1')).toBe(2);
      // approve through a session revoked AFTER the proposal (16)
      const id2 = await svc.propose(s1b.ctx, input({ accountId: acct() }));
      await q('update refresh_tokens set revoked_at = now() where id = $1', [s2.rowId]);
      expect(await code(svc.approve(s2.ctx, id2, 'EV-NO'))).toBe('SESSION_NOT_LIVE');
      expect((await svc.status(s1b.ctx, id2))!.state).toBe('PENDING');
      // 19: self-approval remains denied for a live session
      expect(await code(svc.approve(s1b.ctx, id2, 'SELF'))).toBe('SELF_APPROVAL');
      // an access token's own expiry is enforced at use too
      const short = await serviceFor('dev11_l_admin'); const sc = await sessionContext(a1.id);
      expect(await code(new ReadAuthorizationAdminService(buildDb(await connectAs('dev11_l_admin')), () => Date.now() + 16 * 60_000, createSessionRevalidator(await depsFor(() => Date.now() + 16 * 60_000)), 60 * 60_000).status(sc.ctx, id))).toBe('SESSION_NOT_LIVE');
      void short;
    });

    it('20-22. the database guards stay effective, and an administrator session or token is neither a workload identity nor a way to Stripe secrets', async () => {
      const { ctx, header } = await sessionContext(a1.id);
      // 20: the app login still cannot write, and the verifier still reads only through its function
      const app = await connectAs('dev11_l_app');
      expect((await tryQ(app, "update stripe_read_authorizations set state='APPROVED'")).rows).toEqual([]);
      expect((await tryQ(app, `select public.stripe_read_auth_approve('${randomUUID()}'::uuid, '${a2.id}'::uuid, 'X')`)).error).toMatch(/permission denied/);
      expect((await tryQ(admin, `update stripe_read_authorizations set state='APPROVED', version=2, approved_by='${plain}', approval_evidence_ref='E', approved_at_ms=0 where id in (select id from stripe_read_authorizations where state='PENDING' limit 1)`)).error).toMatch(/READ_AUTH_ADMIN_REQUIRED/);
      // 21: nothing an administrator holds is a workload identity
      const authority = createWorkloadAuthority({ source: { load: async () => ({ workloadId: WORKLOAD, environment: 'development', accountId: ACCT, realm: 'test', methods: ['INVOICE_RETRIEVE'], credentialRef: 'cred:r1', signingKeyPurpose: 'SYNTHETIC_RUNTIME', validFromMs: 0, expiresAtMs: Date.now() + 3_600_000, revokedAtMs: null }) }, environment: 'development', clock: () => Date.now() });
      for (const f of [ctx, header, header.slice(7), { workloadId: WORKLOAD, adminUserId: a1.id }]) {
        expect(await authority.check(f, { environment: 'development', accountId: ACCT, realm: 'test', methodId: 'INVOICE_RETRIEVE' })).toBe('WORKLOAD_NOT_TRUSTED');
        expect(() => gateForWorkload({ authority, identity: f as any, store: createDurableAuthorizationStore(undefined), mapping: MappingRegistry.catalog() })).toThrow();
      }
      // 22: and cannot resolve Stripe secrets
      let reads = 0;
      const custody = createCredentialCustody({ descriptors: { load: async () => null }, secrets: { read: async () => { reads++; return GOOD_KEY; } }, workloads: authority, clock: () => Date.now() });
      for (const f of [ctx, header, header.slice(7), { workloadId: WORKLOAD }]) expect(() => custody.sourceFor(f as any)).toThrow(/NOT_A_TRUSTED_WORKLOAD/);
      expect(reads).toBe(0);
    });
  });

  describe('1-10 over real records, and the full synthetic chain', () => {
    it('administrator authentication resolves from the persisted users and refresh_tokens rows: suspended, demoted, logged-out and non-admin users never get a context', async () => {
      const mkUser = async (role: string | null, status = 'active') => (await q<{ id: string }>('insert into users(email,password_hash,full_name,status,platform_role) values($1,$2,$3,$4,$5) returning id', [`d11-${randomUUID()}@example.test`, 'x', 'D11', status, role]))[0]!.id;
      const authenticate = async (userId: string, header?: string) => authenticateAdminSession(await depsFor(), header ?? [...sessionOf.entries()].filter(([, v]) => v.userId === userId).map(([h]) => h).pop() ?? '');
      const sus = await mkUser('admin', 'suspended'); await login(sus); expect(await authenticate(sus)).toEqual({ ok: false, reason: 'ACCOUNT_NOT_ACTIVE' });
      const nonAdmin = await mkUser(null); await login(nonAdmin); expect(await authenticate(nonAdmin)).toEqual({ ok: false, reason: 'NOT_PLATFORM_ADMIN' });
      const billing = await mkUser('billing'); await login(billing); expect(await authenticate(billing)).toEqual({ ok: false, reason: 'NOT_PLATFORM_ADMIN' });
      const loggedOut = await mkUser('admin'); await login(loggedOut, { revoked: true }); expect(await authenticate(loggedOut)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      const noSession = await mkUser('admin'); expect(await authenticate(noSession, `Bearer ${await signAccessToken(noSession, SECRET, randomUUID())}`)).toEqual({ ok: false, reason: 'SESSION_REVOKED' }); // a bound token whose session does not exist
      const deleted = await mkUser('admin'); await login(deleted); await q('update users set is_deleted = true, deleted_at = now() where id = $1', [deleted]);
      expect(await authenticate(deleted)).toMatchObject({ ok: false });
      const ok = await mkUser('admin'); await login(ok); expect(await authenticate(ok)).toMatchObject({ ok: true });
      await q('update refresh_tokens set revoked_at = now() where user_id = $1', [ok]); // logout / password change revokes the session records
      expect(await authenticate(ok)).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
      const ghost = randomUUID(); expect(await authenticate(ghost, `Bearer ${await signAccessToken(ghost, SECRET, randomUUID())}`)).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' });
    });

    it('46-47. an approved synthetic chain builds synthetic proof only; real retrieval stays impossible (no verified mapping, no real key purpose) and write or unapproved methods never reach the platform fetch', async () => {
      const c1 = await contextFor(a1.id); const c2 = await contextFor(a2.id); const svc = await serviceFor();
      const acc = acct(); const ids: string[] = [];
      for (const m of ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE', 'REFUNDS_LIST'] as const) { const id = await svc.propose(c1, input({ accountId: acc, methodId: m })); await svc.approve(c2, id, `EV-${m}`); ids.push(id); }
      const now = Date.now();
      const wcfg = { workloadId: WORKLOAD, environment: 'development', accountId: acc, realm: 'test', methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], credentialRef: 'cred:d11-primary', signingKeyPurpose: 'SYNTHETIC_RUNTIME', validFromMs: 0, expiresAtMs: now + 3_600_000, revokedAtMs: null };
      const authority = createWorkloadAuthority({ source: { load: async () => wcfg }, environment: 'development', clock: () => Date.now() });
      const resolved = await authority.resolve(); if (!resolved.ok) throw new Error(resolved.reason); const identity = resolved.identity;
      const secrets = { reads: 0 };
      const custody = createCredentialCustody({ descriptors: { load: async () => ({ ref: 'cred:d11-primary', workloadId: WORKLOAD, accountId: acc, mode: 'test', revokedAtMs: null, versions: [{ version: 'v1', notBeforeMs: 0, notAfterMs: now + 3_600_000, revokedAtMs: null }] }) }, secrets: { read: async () => { secrets.reads++; return GOOD_KEY; } }, workloads: authority, clock: () => Date.now() });
      const pair = generateKeyPairSync('ed25519'); const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
      const keys = createSigningCustody({ directory: { load: async () => [{ keyId: 'syn-d11-v1', version: 1, purpose: 'SYNTHETIC_RUNTIME', publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex'), notBeforeMs: 0, notAfterMs: now + 3_600_000, verifyUntilMs: now + 7_200_000, revokedAtMs: null }] }, signers: { signerFor: id => (id === 'syn-d11-v1' ? { keyId: id, sign: async m => new Uint8Array(nodeSign(null, Buffer.from(m), pair.privateKey)) } : null) }, clock: () => Date.now() });
      const gate = gateForWorkload({ authority, identity, store: createDurableAuthorizationStore(buildDb(await connectAs('dev11_l_verifier'))), mapping: MappingRegistry.catalog() });
      const fetched: Array<{ url: string; method: string }> = [];
      const { createStripeGetTransport } = await import('../../src/billing/stripe-read');
      const fetchImpl = (async (u: any, init: any) => { fetched.push({ url: String(u), method: init.method }); const url = String(u); return new Response(JSON.stringify(url.endsWith('/v1/account') ? { object: 'account', id: acc } : { object: 'invoice', id: 'in_D11', livemode: false, status: 'paid', currency: 'usd' })); }) as unknown as typeof fetch;
      const transport = createStripeGetTransport({ credentials: custody.sourceFor(identity), fetchImpl, clock: () => Date.now() });
      const runtime = createSyntheticTrustedRuntime({ signer: await keys.activeSigner('SYNTHETIC_RUNTIME'), keyRing: keys.keyRing, gate, clock: () => Date.now(), transport });
      const verifier = createObservationVerifier({ keyRing: keys.keyRing, clock: () => Date.now() });
      const proof = await captureProof({ runtime, verifier, store: createInMemoryProofStore(), clock: () => Date.now(), audit: () => undefined }, { businessId: biz, accountId: acc, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_D11' });
      if (!proof.ok) throw new Error(JSON.stringify(proof));
      expect(proof.proof).toMatchObject({ captureOrigin: 'SYNTHETIC_RUNTIME', runtimeKeyId: 'syn-d11-v1', accountId: acc, workloadId: WORKLOAD, authorizationId: ids[1] });
      expect(fetched.map(f => `${f.method} ${f.url.replace('https://api.stripe.com', '')}`)).toEqual(['GET /v1/account', 'GET /v1/invoices/in_D11']); expect(secrets.reads).toBe(2);
      // EVIDENCE (real retrieval for settlement) needs a TEST_MODE_VERIFIED mapping, which does not exist: denied before any request, whatever is approved
      const before = fetched.length;
      expect(await runtime.read({ businessId: biz, accountId: acc, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_D11', apiVersion: '2026-05-27.dahlia', purpose: 'EVIDENCE' })).toEqual({ ok: false, kind: 'DENIED', reason: 'MAPPING_NOT_VERIFIED' });
      // the approved REFUNDS_LIST row (the database accepts it) and every write-shaped name reach nothing: the workload scope and the registry both refuse
      for (const bad of ['REFUNDS_LIST', 'REFUNDS_CREATE', 'POST /v1/refunds', 'INVOICE_LINES_LIST', 'DISPUTES_LIST']) expect(await runtime.read({ businessId: biz, accountId: acc, methodId: bad as any, invoiceId: 'in_D11', apiVersion: '2026-05-27.dahlia', purpose: 'PROOF' }), bad).toMatchObject({ ok: false, kind: 'DENIED' });
      expect(fetched).toHaveLength(before);
      // revoking the invoice authorization stops the very next read, before the credential is resolved
      await svc.revoke(c1, ids[1]!, 'OWNER_REQUEST'); const reads = secrets.reads;
      expect(await runtime.read({ businessId: biz, accountId: acc, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_D11', apiVersion: '2026-05-27.dahlia', purpose: 'PROOF' })).toEqual({ ok: false, kind: 'DENIED', reason: 'AUTHORIZATION_REVOKED' });
      expect(secrets.reads).toBe(reads); expect(fetched).toHaveLength(before);
    });
  });
});
