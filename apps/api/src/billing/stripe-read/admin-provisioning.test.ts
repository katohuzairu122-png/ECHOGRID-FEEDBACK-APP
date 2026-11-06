/* eslint-disable @typescript-eslint/no-explicit-any -- forgery tests deliberately build malformed objects */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateKeyPairSync, randomUUID, sign as nodeSign } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sign as honoSign } from 'hono/jwt';
import { signAccessToken, signImpersonationToken } from '../../auth/jwt';
import {
  authenticateAdminSession, requireFreshAdmin, isTrustedAdminContext, AdminAuthorityError, createWorkloadAuthority, gateForWorkload, isTrustedWorkloadIdentity, createCredentialCustody, CredentialCustodyError,
  createSigningCustody, SigningCustodyError, createObservationVerifier, createTrustedStripeRuntime, createStripeGetTransport, checkRead, MappingRegistry, captureProof, createInMemoryProofStore, applyProof, ScriptedReadTransport,
  CredentialDenied, type AdminSessionDeps, type CredentialAuditEvent, type RuntimeSigner, type SigningKeyRecord, type ExpectedBinding,
} from './index';
import { createSyntheticTrustedRuntime } from './synthetic-runtime';
import { ACCT, AUTH, NOW, WORKLOAD, account, gateFor, invoice } from './pipeline-fixtures';

/**
 * S08-D1D3-DEV-11 (unit): administrator session authority, trusted workload identity, credential custody and signing-key custody. Everything is synthetic: generated throwaway keys, fake secret providers,
 * in-memory repositories. Nothing contacts Stripe; the stubbed global fetch is the only network surface.
 */
const SECRET = 'dev11-test-access-secret-0123456789abcdef';
const GOOD_KEY = ['rk', 'test', 'Dev11SyntheticCredential0123'].join('_');
const LIVE_KEY = ['rk', 'live', 'Dev11SyntheticLiveCredential01'].join('_');
afterEach(() => vi.unstubAllGlobals());

// ---- administrator session ------------------------------------------------------------------------------------------------------------------------------------------------------------------------
type Row = { id: string; status: string; platformRole: string | null; isDeleted?: boolean; deletedAt?: Date | null };
function sessionRig(over: { user?: Partial<Row> | null; sessions?: Array<{ revokedAt: Date | null; expiresAt: Date }>; clock?: () => number } = {}) {
  const userId = randomUUID();
  const row: Row | undefined = over.user === null ? undefined : { id: userId, status: 'active', platformRole: 'admin', isDeleted: false, deletedAt: null, ...over.user };
  const calls = { users: 0, sessions: 0 };
  const deps: AdminSessionDeps = {
    accessSecret: SECRET, clock: over.clock ?? (() => Date.now()),
    users: { async findById(id) { calls.users++; return row && row.id === id ? row : undefined; } },
    sessions: { async listActiveForUser() { calls.sessions++; return over.sessions ?? [{ revokedAt: null, expiresAt: new Date(Date.now() + 86_400_000) }]; } },
  };
  return { deps, userId: row?.id ?? userId, calls, token: () => signAccessToken(row?.id ?? userId, SECRET) };
}
const bearer = (t: string) => `Bearer ${t}`;

describe('1-10. administrator session authentication', () => {
  it('1. a valid, active administrator session is accepted and yields a branded, frozen, server-origin context that never carries the token', async () => {
    const r = sessionRig(); const token = await r.token();
    const out = await authenticateAdminSession(r.deps, bearer(token));
    if (!out.ok) throw new Error(out.reason);
    const c = out.context;
    expect(isTrustedAdminContext(c)).toBe(true); expect(Object.isFrozen(c) && Object.isFrozen(c.assurance)).toBe(true);
    expect(c).toMatchObject({ adminUserId: r.userId, scope: 'platform:stripe-read-authorization', origin: 'SERVER_SESSION', assurance: { method: 'ACCESS_TOKEN_HS256', impersonated: false, liveSession: true } });
    expect(c.sessionId).toMatch(/^[0-9a-f]{32}$/); expect(JSON.stringify(c)).not.toContain(token); expect(typeof c.verifiedAtMs).toBe('number');
    expect(r.calls).toEqual({ users: 1, sessions: 1 }); // resolved from the persisted records
  });

  it('2. anonymous and malformed credentials are rejected without touching the database', async () => {
    const r = sessionRig();
    for (const h of [undefined, null, '']) expect(await authenticateAdminSession(r.deps, h as any)).toEqual({ ok: false, reason: 'ANONYMOUS' });
    for (const h of ['Basic abc', 'Bearer', 'Bearer ', 'bearer x', 'Bearer a b', `Bearer ${'x'.repeat(5000)}`, 5 as any, {} as any]) expect(await authenticateAdminSession(r.deps, h), String(h)).toMatchObject({ ok: false, reason: expect.stringMatching(/MALFORMED_CREDENTIAL|ANONYMOUS/) });
    expect(r.calls).toEqual({ users: 0, sessions: 0 });
  });

  it('3. expired sessions are rejected, by the token and by the injected clock', async () => {
    const r = sessionRig(); const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = await honoSign({ sub: r.userId, type: 'access', iat: past - 900, exp: past }, SECRET, 'HS256');
    expect(await authenticateAdminSession(r.deps, bearer(expired))).toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
    const late = sessionRig({ clock: () => Date.now() + 16 * 60_000 }); // the clock is past the 15-minute access lifetime
    expect(await authenticateAdminSession(late.deps, bearer(await late.token()))).toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
    expect(r.calls.users).toBe(0);
  });

  it('4. revoked, logged-out and expired session records are rejected even though the access token itself still verifies', async () => {
    for (const sessions of [[], [{ revokedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) }], [{ revokedAt: null, expiresAt: new Date(Date.now() - 1000) }]]) {
      const r = sessionRig({ sessions });
      expect(await authenticateAdminSession(r.deps, bearer(await r.token()))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    }
  });

  it('5. forged claims are rejected: wrong secret, tampered payload, alg none, a claimed admin role, an unknown subject, a non-uuid subject', async () => {
    const r = sessionRig(); const good = await r.token(); const [h, p, s] = good.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: randomUUID(), type: 'access', iat: 1, exp: 9999999999 })).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + 600;
    const cases: Array<[string, string]> = [
      ['wrong secret', await honoSign({ sub: r.userId, type: 'access', iat: 1, exp }, 'another-secret-another-secret-123', 'HS256')],
      ['tampered payload', `${h}.${forgedPayload}.${s}`], ['alg none', `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${p}.`],
      ['refresh type', await honoSign({ sub: r.userId, type: 'refresh', jti: randomUUID(), iat: 1, exp }, SECRET, 'HS256')],
      ['non-uuid subject', await honoSign({ sub: 'admin', type: 'access', iat: 1, exp }, SECRET, 'HS256')], ['junk', 'a.b.c'],
    ];
    for (const [label, t] of cases) expect(await authenticateAdminSession(r.deps, bearer(t)), label).toMatchObject({ ok: false, reason: expect.stringMatching(/INVALID_TOKEN/) });
    // a correctly signed token for a NON-admin that claims admin rights in its payload gains nothing: the persisted row decides
    const user = sessionRig({ user: { platformRole: null } });
    const claimed = await honoSign({ sub: user.userId, type: 'access', iat: 1, exp, platformRole: 'admin', isAdmin: true, role: 'admin' }, SECRET, 'HS256');
    expect(await authenticateAdminSession(user.deps, bearer(claimed))).toEqual({ ok: false, reason: 'NOT_PLATFORM_ADMIN' });
    const ghost = sessionRig({ user: null });
    expect(await authenticateAdminSession(ghost.deps, bearer(await ghost.token()))).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' });
  });

  it('6-7. non-administrators and every inactive or deleted administrator are rejected', async () => {
    for (const platformRole of [null, 'support', 'billing', 'owner', 'ADMIN', '']) {
      const r = sessionRig({ user: { platformRole } });
      expect(await authenticateAdminSession(r.deps, bearer(await r.token())), String(platformRole)).toEqual({ ok: false, reason: 'NOT_PLATFORM_ADMIN' });
    }
    for (const user of [{ status: 'suspended' }, { status: 'deactivated' }, { status: 'invited' }, { status: 'ACTIVE' }, { isDeleted: true }, { deletedAt: new Date() }]) {
      const r = sessionRig({ user });
      expect(await authenticateAdminSession(r.deps, bearer(await r.token())), JSON.stringify(user)).toEqual({ ok: false, reason: 'ACCOUNT_NOT_ACTIVE' });
    }
  });

  it('8. a caller-supplied administrator id cannot override the authenticated identity: contexts are unforgeable and lifecycle calls take no actor', async () => {
    const r = sessionRig(); const out = await authenticateAdminSession(r.deps, bearer(await r.token()));
    if (!out.ok) throw new Error('auth');
    const victim = randomUUID();
    expect(requireFreshAdmin(out.context, Date.now(), 60_000)).toBe(r.userId);
    const forged = [{ adminUserId: victim, scope: 'platform:stripe-read-authorization', verifiedAtMs: Date.now(), origin: 'SERVER_SESSION' }, { ...out.context, adminUserId: victim }, structuredClone(out.context), Object.create(out.context), JSON.parse(JSON.stringify(out.context)), victim, null];
    for (const f of forged) { expect(isTrustedAdminContext(f)).toBe(false); expect(() => requireFreshAdmin(f, Date.now(), 60_000)).toThrow(AdminAuthorityError); }
    expect(() => requireFreshAdmin(out.context, Date.now() + 61_000, 60_000)).toThrow(/CONTEXT_STALE/); // a stale context cannot be replayed later
    expect(() => requireFreshAdmin(out.context, out.context.verifiedAtMs - 1, 60_000)).toThrow(/CONTEXT_STALE/);
    expect(() => requireFreshAdmin(out.context, Date.now(), 0)).toThrow(/CONTEXT_STALE/);
    // extra arguments (an id, a role flag) are not parameters of the authentication boundary at all
    expect(authenticateAdminSession.length).toBe(2);
  });

  it('9. cross-tenant and delegated authority is refused: business-only users, other platform tiers and impersonation tokens (even of an administrator) are never administrators', async () => {
    const owner = sessionRig({ user: { platformRole: null } });
    expect(await authenticateAdminSession(owner.deps, bearer(await owner.token()))).toEqual({ ok: false, reason: 'NOT_PLATFORM_ADMIN' });
    const admin = sessionRig(); const target = sessionRig({ user: { platformRole: null } });
    const imp = await signImpersonationToken(target.userId, admin.userId, SECRET);
    expect(await authenticateAdminSession(target.deps, bearer(imp.token))).toEqual({ ok: false, reason: 'IMPERSONATED_SESSION' });
    const impAdmin = await signImpersonationToken(admin.userId, admin.userId, SECRET);
    expect(await authenticateAdminSession(admin.deps, bearer(impAdmin.token))).toEqual({ ok: false, reason: 'IMPERSONATED_SESSION' });
  });

  it('10. any verification failure fails closed: repository errors, a malformed row, a missing or weak secret, a broken clock', async () => {
    const r = sessionRig(); const token = await r.token();
    const boom = { ...r.deps, users: { async findById() { throw new Error('db down'); } } };
    expect(await authenticateAdminSession(boom, bearer(token))).toEqual({ ok: false, reason: 'VERIFICATION_UNAVAILABLE' });
    const boom2 = { ...r.deps, sessions: { async listActiveForUser() { throw new Error('db down'); } } };
    expect(await authenticateAdminSession(boom2, bearer(token))).toEqual({ ok: false, reason: 'VERIFICATION_UNAVAILABLE' });
    const wrongRow = { ...r.deps, users: { async findById() { return { id: randomUUID(), status: 'active', platformRole: 'admin' }; } } };
    expect(await authenticateAdminSession(wrongRow, bearer(token))).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' }); // the persisted row must be the subject's
    for (const d of [{ ...r.deps, accessSecret: '' }, { ...r.deps, accessSecret: 'short' }, { ...r.deps, clock: undefined as any }, { ...r.deps, clock: () => NaN }, null as any, undefined as any])
      expect(await authenticateAdminSession(d, bearer(token))).toMatchObject({ ok: false });
  });
});

// ---- workload identity ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const wl = (over: Record<string, unknown> = {}) => ({ workloadId: WORKLOAD, environment: 'development', accountId: ACCT, realm: 'test', methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], credentialRef: 'cred:dev11-primary', signingKeyPurpose: 'SYNTHETIC_RUNTIME', validFromMs: NOW - 1000, expiresAtMs: NOW + 3_600_000, revokedAtMs: null, ...over });
function workloadRig(initial: unknown = wl(), env: 'development' | 'staging' | 'production' = 'development', clock = () => NOW) {
  const state = { config: initial as unknown, loads: 0, throws: false };
  const source = { async load() { state.loads++; if (state.throws) throw new Error('config store down'); return state.config; } };
  return { state, authority: createWorkloadAuthority({ source, environment: env, clock }), clock };
}
const use = (over: Record<string, unknown> = {}) => ({ environment: 'development', accountId: ACCT, realm: 'test', methodId: 'INVOICE_RETRIEVE', ...over });
const resolveOk = async (r: ReturnType<typeof workloadRig>) => { const x = await r.authority.resolve(); if (!x.ok) throw new Error(x.reason); return x.identity; };

describe('21-30. trusted workload identity', () => {
  it('21. the trusted development workload identity resolves from trusted configuration only, frozen and branded', async () => {
    const r = workloadRig(); const id = await resolveOk(r);
    expect(isTrustedWorkloadIdentity(id)).toBe(true); expect(Object.isFrozen(id) && Object.isFrozen(id.methods)).toBe(true);
    expect(id).toMatchObject({ workloadId: WORKLOAD, environment: 'development', accountId: ACCT, realm: 'test', methods: ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'], credentialRef: 'cred:dev11-primary', signingKeyPurpose: 'SYNTHETIC_RUNTIME' });
    expect('revokedAtMs' in id).toBe(false);
    expect(await r.authority.check(id, use())).toBeNull();
    expect(createWorkloadAuthority.length).toBe(1); // no parameter names a workload: only trusted configuration does
  });

  it('22. a caller-supplied workload identity is rejected: object literals, clones, spreads and ids are not identities', async () => {
    const r = workloadRig(); const id = await resolveOk(r);
    for (const f of [{ ...id }, structuredClone(id), Object.create(id), JSON.parse(JSON.stringify(id)), WORKLOAD, { workloadId: WORKLOAD, environment: 'development' }, null, undefined])
      expect(await r.authority.check(f, use()), String(JSON.stringify(f))).toBe('WORKLOAD_NOT_TRUSTED');
    expect(() => gateForWorkload({ authority: r.authority, identity: { ...id } as any, store: gateFor(AUTH).store, mapping: MappingRegistry.catalog() })).toThrow(/WORKLOAD_NOT_TRUSTED/);
    // an identity minted by one authority is still re-validated against the configuration, which may name a different workload now
    r.state.config = wl({ workloadId: 'wl-someone-else' });
    expect(await r.authority.check(id, use())).toBe('WORKLOAD_NOT_TRUSTED');
  });

  it('23-25. a wrong environment, account or realm is rejected, at resolution and at every use', async () => {
    expect(await workloadRig(wl({ environment: 'staging' })).authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_WRONG_ENVIRONMENT' }); // configured for another environment than this runtime
    expect(await workloadRig(wl({ environment: 'production' }), 'development').authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_WRONG_ENVIRONMENT' });
    const r = workloadRig(); const id = await resolveOk(r);
    expect(await r.authority.check(id, use({ environment: 'production' }))).toBe('WORKLOAD_WRONG_ENVIRONMENT'); // 23
    expect(await r.authority.check(id, use({ accountId: 'acct_Other1' }))).toBe('WORKLOAD_WRONG_ACCOUNT'); // 24
    expect(await r.authority.check(id, use({ realm: 'live' }))).toBe('WORKLOAD_WRONG_REALM'); // 25
    expect(await workloadRig(wl({ realm: 'live' })).authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MALFORMED' }); // a live realm cannot even be configured
    expect(await r.authority.check(id, null as any)).toBe('WORKLOAD_WRONG_ENVIRONMENT');
  });

  it('26-27. expired, not-yet-valid and revoked workload authority fail closed, and revocation or expiry takes effect on the very next check', async () => {
    let now = NOW; const r = workloadRig(wl(), 'development', () => now); const id = await resolveOk(r);
    now = NOW + 3_600_000;
    expect(await r.authority.check(id, use())).toBe('WORKLOAD_EXPIRED'); expect(await r.authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_EXPIRED' }); // 26
    now = NOW - 5000;
    expect(await r.authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_NOT_YET_VALID' });
    now = NOW; expect(await r.authority.check(id, use())).toBeNull();
    r.state.config = wl({ revokedAtMs: NOW - 1 });
    expect(await r.authority.check(id, use())).toBe('WORKLOAD_REVOKED'); expect(await r.authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_REVOKED' }); // 27
  });

  it('28. unapproved read methods stay inaccessible: the four unauthorized reads, write-shaped names and prototype keys can neither be configured nor used', async () => {
    const r = workloadRig(); const id = await resolveOk(r);
    for (const m of ['INVOICE_LINES_LIST', 'PAYMENT_RETRIEVE', 'REFUNDS_LIST', 'DISPUTES_LIST', 'REFUNDS_CREATE', 'POST /v1/refunds', '__proto__', '', 5, null])
      expect(await r.authority.check(id, use({ methodId: m })), String(m)).toBe('WORKLOAD_METHOD_NOT_PERMITTED');
    for (const methods of [['REFUNDS_LIST'], ['INVOICE_RETRIEVE', 'DISPUTES_LIST'], [], ['INVOICE_RETRIEVE', 'INVOICE_RETRIEVE'], 'INVOICE_RETRIEVE', ['__proto__']])
      expect(await workloadRig(wl({ methods })).authority.resolve(), JSON.stringify(methods)).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MALFORMED' });
    const narrow = workloadRig(wl({ methods: ['ACCOUNT_RETRIEVE_CURRENT'] })); const nid = await resolveOk(narrow);
    expect(await narrow.authority.check(nid, use({ methodId: 'INVOICE_RETRIEVE' }))).toBe('WORKLOAD_METHOD_NOT_PERMITTED');
  });

  it('29. missing, unavailable and malformed workload configuration fails closed', async () => {
    for (const bad of [undefined, null]) { const x = workloadRig(); x.state.config = bad; expect(await x.authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MISSING' }); }
    expect(await createWorkloadAuthority({ source: undefined, environment: 'development', clock: () => NOW }).resolve()).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MISSING' });
    expect(await createWorkloadAuthority({ source: { load: async () => wl() }, environment: 'qa' as any, clock: () => NOW }).resolve()).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MISSING' });
    const down = workloadRig(); const id = await resolveOk(down); down.state.throws = true;
    expect(await down.authority.resolve()).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_UNAVAILABLE' });
    expect(await down.authority.check(id, use())).toBe('WORKLOAD_CONFIG_UNAVAILABLE'); // an outage mid-run denies too
    const malformed = [wl({ extra: 1 }), { ...wl(), workloadId: undefined }, wl({ workloadId: '' }), wl({ accountId: 'cus_1' }), wl({ environment: 'qa' }), wl({ validFromMs: 5, expiresAtMs: 5 }), wl({ expiresAtMs: 'soon' }), wl({ revokedAtMs: 'no' }),
      wl({ signingKeyPurpose: 'ANY' }), wl({ credentialRef: 'sk_test_abcdefgh12345678' }), wl({ credentialRef: `cred:${['sk', 'test', 'abcdefgh12345678'].join('_')}` }), wl({ credentialRef: 'cred:' }), [], 'x', 5];
    for (const m of malformed) expect(await workloadRig(m).authority.resolve(), JSON.stringify(m) + String(malformed.indexOf(m))).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MALFORMED' });
  });

  it('30. browser clients and administrators cannot impersonate the verifier workload; the workload check precedes the authorization store and credential resolution', async () => {
    const r = workloadRig(); const id = await resolveOk(r);
    const admin = sessionRig(); const ctx = await authenticateAdminSession(admin.deps, bearer(await admin.token()));
    if (!ctx.ok) throw new Error('auth');
    for (const f of [ctx.context, await admin.token(), { adminUserId: admin.userId }, { workloadId: WORKLOAD }]) {
      expect(await r.authority.check(f, use())).toBe('WORKLOAD_NOT_TRUSTED');
      expect(() => gateForWorkload({ authority: r.authority, identity: f as any, store: gateFor(AUTH).store, mapping: MappingRegistry.catalog() })).toThrow();
    }
    // a workload denial happens before the authorization store is consulted
    let lookups = 0; const store = { async lookup(q: any) { lookups++; return gateFor(AUTH).store.lookup(q); } };
    const gate = gateForWorkload({ authority: r.authority, identity: id, store, mapping: MappingRegistry.catalog() });
    expect(gate.workloadId).toBe(WORKLOAD);
    const q = { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE' as const, apiVersion: '2026-05-27.dahlia', purpose: 'PROOF' as const };
    r.state.config = wl({ revokedAtMs: NOW - 1 });
    expect(await checkRead(gate, q, NOW)).toEqual({ ok: false, reason: 'WORKLOAD_REVOKED' }); expect(lookups).toBe(0);
    r.state.config = wl(); expect(await checkRead(gate, { ...q, accountId: 'acct_Other1' }, NOW)).toEqual({ ok: false, reason: 'WORKLOAD_WRONG_ACCOUNT' }); expect(lookups).toBe(0);
    expect(await checkRead({ ...gate, workloadCheck: async () => { throw new Error('boom'); } }, q, NOW)).toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_UNAVAILABLE' });
  });
});

// ---- credential custody ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const descriptor = (over: Record<string, unknown> = {}) => ({ ref: 'cred:dev11-primary', workloadId: WORKLOAD, accountId: ACCT, mode: 'test', revokedAtMs: null, versions: [{ version: 'v1', notBeforeMs: NOW - 10_000, notAfterMs: NOW + 3_600_000, revokedAtMs: null }], ...over });
function custodyRig(o: { desc?: unknown; secrets?: Record<string, string | null | 'THROW'>; workload?: unknown; clock?: () => number } = {}) {
  const wr = workloadRig(o.workload ?? wl({ validFromMs: 0, expiresAtMs: NOW * 10 }), 'development', o.clock ?? (() => NOW));
  const st = { desc: (o.desc === undefined ? descriptor() : o.desc) as unknown, secrets: o.secrets ?? { 'cred:dev11-primary|v1': GOOD_KEY }, reads: [] as string[], descLoads: 0 };
  const audit: CredentialAuditEvent[] = [];
  const custody = createCredentialCustody({
    descriptors: { async load() { st.descLoads++; return st.desc; } },
    secrets: { async read(ref, version) { st.reads.push(`${ref}|${version}`); const v = st.secrets[`${ref}|${version}`]; if (v === 'THROW') throw new Error(`vault error for ${GOOD_KEY}`); return v ?? null; } },
    workloads: wr.authority, clock: o.clock ?? (() => NOW), audit: e => audit.push(e),
  });
  return { ...wr, st, audit, custody, source: async () => custody.sourceFor(await resolveOk(wr)) };
}
const BIND = { accountId: ACCT, workloadId: WORKLOAD };
const denial = async (p: Promise<unknown>) => { try { await p; return 'RESOLVED'; } catch (e) { return e instanceof CredentialDenied ? e.code : String(e); } };

describe('31-38. credential provisioning', () => {
  it('31. a synthetic test credential resolves for the authorized workload, bound to its account and workload, expiring with its version', async () => {
    const r = custodyRig(); const src = await r.source();
    expect(await src.resolve(BIND)).toEqual({ apiKey: GOOD_KEY, accountId: ACCT, workloadId: WORKLOAD, validUntilMs: NOW + 3_600_000 });
    expect(r.audit).toEqual([{ event: 'credential.resolved', ref: 'cred:dev11-primary', workloadId: WORKLOAD, accountId: ACCT, version: 'v1', reason: null, atMs: NOW }]);
    // end to end through the restricted transport: the credential is used as the bearer of a fixed GET, and only then
    const seen: string[] = []; const fetchImpl = (async (u: any, init: any) => { seen.push(`${init.method} ${u} ${init.headers.Authorization === `Bearer ${GOOD_KEY}`}`); return new Response(JSON.stringify(account)); }) as unknown as typeof fetch;
    const t = createStripeGetTransport({ credentials: src, fetchImpl, clock: () => NOW });
    expect(await t.get('ACCOUNT_RETRIEVE_CURRENT', undefined, BIND)).toEqual(account); expect(seen).toEqual(['GET https://api.stripe.com/v1/account true']);
  });

  it('32. a live-mode credential is rejected and nothing is requested', async () => {
    const r = custodyRig({ secrets: { 'cred:dev11-primary|v1': LIVE_KEY } }); const src = await r.source();
    expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_LIVE_MODE');
    const fetchImpl = vi.fn(); const t = createStripeGetTransport({ credentials: src, fetchImpl: fetchImpl as any, clock: () => NOW });
    expect(await denial(t.get('ACCOUNT_RETRIEVE_CURRENT', undefined, BIND))).toBe('CREDENTIAL_LIVE_MODE'); expect(fetchImpl).not.toHaveBeenCalled(); // resolution failure produces no provider request
    for (const bad of ['sk_live_x', 'whsec_abc', '', 'rk_test_short', 5 as any]) { const x = custodyRig({ secrets: { 'cred:dev11-primary|v1': bad } }); expect(await denial((await x.source()).resolve(BIND)), String(bad)).toMatch(/CREDENTIAL_(LIVE_MODE|MALFORMED)/); }
    expect(await denial(custodyRig({ desc: descriptor({ mode: 'live' }) }).source().then(s => s.resolve(BIND)))).toBe('CREDENTIAL_MALFORMED');
  });

  it('33. missing credential configuration fails closed: no descriptor, no secret, a malformed descriptor, an unavailable store or provider', async () => {
    expect(await denial((await custodyRig({ desc: null }).source()).resolve(BIND))).toBe('CREDENTIAL_MISSING');
    expect(await denial((await custodyRig({ secrets: {} }).source()).resolve(BIND))).toBe('CREDENTIAL_MISSING');
    for (const d of [{}, descriptor({ extra: 1 }), descriptor({ versions: [] }), descriptor({ ref: 'cred:other' }), descriptor({ versions: [{ version: 'v1', notBeforeMs: 5, notAfterMs: 5, revokedAtMs: null }] }), descriptor({ versions: [{ version: 'v1', notBeforeMs: 1, notAfterMs: 2, revokedAtMs: null }, { version: 'v1', notBeforeMs: 1, notAfterMs: 2, revokedAtMs: null }] }), 'x'])
      expect(await denial((await custodyRig({ desc: d }).source()).resolve(BIND)), JSON.stringify(d)).toBe('CREDENTIAL_MALFORMED');
    const r = custodyRig(); const src = await r.source(); r.st.secrets['cred:dev11-primary|v1'] = 'THROW';
    expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_SOURCE_UNAVAILABLE');
    const down = createCredentialCustody({ descriptors: { async load() { throw new Error('x'); } }, secrets: { async read() { return GOOD_KEY; } }, workloads: r.authority, clock: () => NOW });
    expect(await denial(down.sourceFor(await resolveOk(r)).resolve(BIND))).toBe('CREDENTIAL_SOURCE_UNAVAILABLE');
    expect(() => createCredentialCustody({ descriptors: null as any, secrets: null as any, workloads: null as any, clock: () => NOW })).toThrow(CredentialCustodyError);
  });

  it('34-35. expired, revoked and not-yet-valid credentials fail closed, and revocation applies to the next resolution', async () => {
    let now = NOW; const r = custodyRig({ clock: () => now }); const src = await r.source();
    now = NOW + 3_600_000; expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_EXPIRED'); // 34
    now = NOW - 20_000; expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_MISSING');
    now = NOW; expect(await denial(src.resolve(BIND))).toBe('RESOLVED');
    r.st.desc = descriptor({ revokedAtMs: NOW - 1 }); expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_REVOKED'); // 35
    r.st.desc = descriptor({ versions: [{ version: 'v1', notBeforeMs: NOW - 10_000, notAfterMs: NOW + 3_600_000, revokedAtMs: NOW - 1 }] }); expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_REVOKED');
    expect(r.audit.filter(e => e.event === 'credential.denied').map(e => e.reason)).toEqual(['CREDENTIAL_EXPIRED', 'CREDENTIAL_MISSING', 'CREDENTIAL_REVOKED', 'CREDENTIAL_REVOKED']);
  });

  it('36. credential values are absent from audit events, errors, results other than the transport record, and the source object', async () => {
    const r = custodyRig({ secrets: { 'cred:dev11-primary|v1': 'THROW' } }); const src = await r.source();
    let err: any; try { await src.resolve(BIND); } catch (e) { err = e; }
    const ok = custodyRig(); const okSrc = await ok.source(); await okSrc.resolve(BIND);
    const live = custodyRig({ secrets: { 'cred:dev11-primary|v1': LIVE_KEY } }); let lerr: any; try { await (await live.source()).resolve(BIND); } catch (e) { lerr = e; }
    const dump = JSON.stringify([err?.message, err?.code, err?.stack?.split('\n')[0], lerr?.message, lerr?.code, r.audit, ok.audit, live.audit, Object.keys(okSrc), String(okSrc.resolve)]);
    expect(dump).not.toContain(GOOD_KEY); expect(dump).not.toContain(LIVE_KEY); expect(dump).not.toMatch(/(rk|sk)_(test|live)_[A-Za-z0-9]{8}/);
    expect(Object.keys(okSrc)).toEqual(['resolve']);
    // the credential reference is an opaque name and may not contain a secret
    await expect(createWorkloadAuthority({ source: { load: async () => wl({ credentialRef: GOOD_KEY }) }, environment: 'development', clock: () => NOW }).resolve()).resolves.toEqual({ ok: false, reason: 'WORKLOAD_CONFIG_MALFORMED' });
  });

  it('37. rotation overlap: the newest valid version is used, the previous one is the fallback while both are valid, the old version retires, and revoking the new one falls back or denies', async () => {
    const two = descriptor({ versions: [{ version: 'v1', notBeforeMs: NOW - 100_000, notAfterMs: NOW + 1000, revokedAtMs: null }, { version: 'v2', notBeforeMs: NOW - 1000, notAfterMs: NOW + 7_200_000, revokedAtMs: null }] });
    const k1 = ['rk', 'test', 'Dev11RotationVersionOne0001'].join('_'); const k2 = ['rk', 'test', 'Dev11RotationVersionTwo0002'].join('_');
    let now = NOW; const r = custodyRig({ desc: two, secrets: { 'cred:dev11-primary|v1': k1, 'cred:dev11-primary|v2': k2 }, clock: () => now }); const src = await r.source();
    expect((await src.resolve(BIND))!.apiKey).toBe(k2); expect(r.st.reads).toEqual(['cred:dev11-primary|v2']); // overlap: both valid, the newest wins
    r.st.secrets['cred:dev11-primary|v2'] = null; r.st.reads.length = 0;
    expect((await src.resolve(BIND))!.apiKey).toBe(k1); expect(r.st.reads).toEqual(['cred:dev11-primary|v2', 'cred:dev11-primary|v1']); // v2 not provisioned yet: fall back to v1 during the overlap
    r.st.secrets['cred:dev11-primary|v2'] = k2; now = NOW + 1000;
    expect((await src.resolve(BIND))!.apiKey).toBe(k2); r.st.reads.length = 0; // v1 retired at its end
    r.st.desc = descriptor({ versions: [{ version: 'v1', notBeforeMs: NOW - 100_000, notAfterMs: NOW + 5000, revokedAtMs: null }, { version: 'v2', notBeforeMs: NOW - 1000, notAfterMs: NOW + 7_200_000, revokedAtMs: NOW }] });
    now = NOW + 1; expect((await src.resolve(BIND))!.apiKey).toBe(k1); // v2 revoked: only v1 remains, and it still works until its end
    now = NOW + 5000; expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_EXPIRED'); // v1 expired and v2 revoked: nothing usable
    r.st.desc = descriptor({ versions: [{ version: 'v1', notBeforeMs: NOW - 100_000, notAfterMs: NOW + 5000, revokedAtMs: NOW }, { version: 'v2', notBeforeMs: NOW - 1000, notAfterMs: NOW + 7_200_000, revokedAtMs: NOW }] });
    expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_REVOKED'); // every version revoked
  });

  it('38. untrusted callers cannot resolve secrets: only a genuine workload identity obtains a source, and the workload is authorized before the secret provider is touched', async () => {
    const r = custodyRig(); const id = await resolveOk(r); const ctxRig = sessionRig(); const ctx = await authenticateAdminSession(ctxRig.deps, bearer(await ctxRig.token()));
    if (!ctx.ok) throw new Error('auth');
    for (const f of [{ ...id }, structuredClone(id), id.workloadId, ctx.context, null, undefined, {}]) expect(() => r.custody.sourceFor(f as any)).toThrow(CredentialCustodyError);
    const src = r.custody.sourceFor(id);
    expect(await denial(src.resolve({ accountId: ACCT, workloadId: 'wl-someone-else' }))).toBe('CREDENTIAL_WORKLOAD_MISMATCH');
    expect(await denial(src.resolve({ accountId: 'acct_Other1', workloadId: WORKLOAD }))).toBe('CREDENTIAL_ACCOUNT_MISMATCH');
    expect(await denial(src.resolve(null as any))).toBe('CREDENTIAL_WORKLOAD_MISMATCH');
    expect(r.st.reads).toEqual([]); expect(r.st.descLoads).toBe(0);
    r.state.config = wl({ revokedAtMs: NOW - 1 }); // the workload is revoked after the source was handed out
    expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_WORKLOAD_NOT_AUTHORIZED'); expect(r.st.reads).toEqual([]); expect(r.st.descLoads).toBe(0);
    r.state.config = wl({ accountId: 'acct_Other1' }); expect(await denial(src.resolve(BIND))).toBe('CREDENTIAL_WORKLOAD_NOT_AUTHORIZED');
    // a descriptor that belongs to another workload or account is refused
    const r2 = custodyRig({ desc: descriptor({ workloadId: 'wl-other' }) }); expect(await denial((await r2.source()).resolve(BIND))).toBe('CREDENTIAL_WORKLOAD_MISMATCH');
    const r3 = custodyRig({ desc: descriptor({ accountId: 'acct_Other1' }) }); expect(await denial((await r3.source()).resolve(BIND))).toBe('CREDENTIAL_ACCOUNT_MISMATCH');
  });
});

// ---- signing-key custody ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function keyPair(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const spki = publicKey.export({ type: 'spki', format: 'der' });
  const signer: RuntimeSigner = Object.freeze({ keyId, sign: async (m: Uint8Array) => new Uint8Array(nodeSign(null, Buffer.from(m), privateKey)) });
  return { signer, publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString('hex') };
}
function custodyKeys(specs: Array<Partial<SigningKeyRecord> & { keyId: string }>, clock: () => number = () => NOW) {
  const pairs = new Map(specs.map(s => [s.keyId, keyPair(s.keyId)])); const state = { dir: null as unknown, loads: 0, down: false };
  const records = (): SigningKeyRecord[] => specs.map(s => ({ version: 1, purpose: 'SYNTHETIC_RUNTIME', publicKeyHex: pairs.get(s.keyId)!.publicKeyHex, notBeforeMs: NOW - 10_000, notAfterMs: NOW + 1_000_000, verifyUntilMs: NOW + 5_000_000, revokedAtMs: null, ...s }));
  state.dir = records();
  const custody = createSigningCustody({ directory: { async load() { state.loads++; if (state.down) throw new Error('dir down'); return state.dir; } }, signers: { signerFor: id => pairs.get(id)?.signer ?? null }, clock });
  return { custody, state, records, pairs };
}
async function issueWith(signer: RuntimeSigner, keyRing: any, kind: 'SYNTHETIC' | 'REAL' = 'SYNTHETIC', clock: () => number = () => NOW) {
  const gate = gateFor(AUTH); const t = new ScriptedReadTransport([account, invoice()]);
  const runtime = kind === 'SYNTHETIC' ? createSyntheticTrustedRuntime({ signer, keyRing, gate, clock, transport: t }) : createTrustedStripeRuntime({ signer, keyRing, gate, clock, credentials: { async resolve() { return { apiKey: GOOD_KEY, accountId: ACCT, workloadId: WORKLOAD, validUntilMs: NOW + 1000 }; } } });
  const out = await runtime.read({ businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1', apiVersion: '2026-05-27.dahlia', purpose: 'EVIDENCE' });
  return { out, t, runtime };
}
const expected = (kind: ExpectedBinding['kind'] = 'SYNTHETIC_RUNTIME'): ExpectedBinding => ({ kind, businessId: 'biz-1', accountId: ACCT, workloadId: WORKLOAD, methodId: 'INVOICE_RETRIEVE', subject: 'in_1', apiVersion: '2026-05-27.dahlia' });

describe('39-45. signing-key custody', () => {
  it('39. a correct-purpose key signs: the newest valid version is selected and its observation verifies against the custody key ring; no private material is reachable', async () => {
    const k = custodyKeys([{ keyId: 'syn-v1', version: 1 }, { keyId: 'syn-v2', version: 2 }]);
    const signer = await k.custody.activeSigner('SYNTHETIC_RUNTIME');
    expect(signer.keyId).toBe('syn-v2'); expect(Object.keys(signer).sort()).toEqual(['keyId', 'sign']);
    expect(JSON.stringify(signer)).not.toMatch(/private|pkcs8|BEGIN/i);
    const { out } = await issueWith(signer, k.custody.keyRing);
    if (!out.ok) throw new Error(JSON.stringify(out));
    expect(out.observation.claims.keyId).toBe('syn-v2');
    const v = createObservationVerifier({ keyRing: k.custody.keyRing, clock: () => NOW });
    expect(await v.verify(out.observation, expected())).toMatchObject({ ok: true, kind: 'SYNTHETIC_RUNTIME' });
  });

  it('39b. a malformed directory record, a retention shorter than issuance and a signer that does not match the selected key are all refused', async () => {
    const k = custodyKeys([{ keyId: 'syn-v1' }]);
    k.state.dir = k.records().map(r => ({ ...r, verifyUntilMs: r.notAfterMs - 1 }));
    await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'DIRECTORY_UNAVAILABLE' });
    const dup = k.records()[0]!; k.state.dir = [dup, dup];
    await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'DIRECTORY_UNAVAILABLE' });
    k.state.dir = k.records();
    const wrong = createSigningCustody({ directory: { load: async () => k.records() }, signers: { signerFor: () => ({ keyId: 'some-other-key', sign: async () => new Uint8Array(64) }) }, clock: () => NOW });
    await expect(wrong.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
    const none = createSigningCustody({ directory: { load: async () => k.records() }, signers: { signerFor: () => null }, clock: () => NOW });
    await expect(none.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'SIGNER_UNAVAILABLE' });
  });

  it('40. wrong-purpose keys are rejected: no valid key of the purpose, the real runtime refusing a synthetic key, and a synthetic runtime refusing a trusted-runtime key', async () => {
    const k = custodyKeys([{ keyId: 'syn-v1' }]);
    await expect(k.custody.activeSigner('TRUSTED_RUNTIME')).rejects.toMatchObject({ code: 'NO_VALID_KEY' });
    const syn = await k.custody.activeSigner('SYNTHETIC_RUNTIME');
    expect((await issueWith(syn, k.custody.keyRing, 'REAL')).out).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_PURPOSE' });
    const real = custodyKeys([{ keyId: 'rt-v1', purpose: 'TRUSTED_RUNTIME' }]);
    const rs = await real.custody.activeSigner('TRUSTED_RUNTIME');
    expect((await issueWith(rs, real.custody.keyRing, 'SYNTHETIC')).out).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_PURPOSE' });
  });

  it('41. a revoked signing key cannot issue proofs: not selected, and a signer selected earlier signs nothing once the key is revoked', async () => {
    const k = custodyKeys([{ keyId: 'syn-v1' }]); const signer = await k.custody.activeSigner('SYNTHETIC_RUNTIME');
    expect((await issueWith(signer, k.custody.keyRing)).out.ok).toBe(true);
    k.state.dir = k.records().map(r => ({ ...r, revokedAtMs: NOW - 1 }));
    await expect(signer.sign(new Uint8Array([1]))).rejects.toMatchObject({ code: 'KEY_NOT_USABLE' });
    await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'NO_VALID_KEY' });
    expect((await issueWith(signer, k.custody.keyRing)).out).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_REVOKED' }); // the runtime refuses before any request
  });

  it('42. an expired (or not-yet-valid) signing key cannot issue proofs', async () => {
    let now = NOW; const k = custodyKeys([{ keyId: 'syn-v1' }], () => now); const signer = await k.custody.activeSigner('SYNTHETIC_RUNTIME');
    now = NOW + 1_000_000;
    await expect(signer.sign(new Uint8Array([1]))).rejects.toMatchObject({ code: 'KEY_NOT_USABLE' });
    await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'NO_VALID_KEY' });
    const rt = await issueWith(signer, k.custody.keyRing, 'SYNTHETIC', () => now);
    expect(rt.out).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_EXPIRED' }); expect(rt.t.calls).toEqual([]);
    now = NOW - 20_000; await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'NO_VALID_KEY' });
  });

  it('43-44. untrusted runtimes cannot mint authentic provenance: an unknown key, a self-made key and a synthetic key all fail as REAL_NETWORK, and synthetic provenance never verifies as REAL_NETWORK', async () => {
    const k = custodyKeys([{ keyId: 'syn-v1' }, { keyId: 'rt-v1', purpose: 'TRUSTED_RUNTIME' }]);
    vi.stubGlobal('fetch', async (u: any) => new Response(JSON.stringify(String(u).endsWith('/v1/account') ? account : invoice()))); // the platform fetch the real runtime builds on
    const attacker = keyPair('attacker-key');
    expect((await issueWith(attacker.signer, k.custody.keyRing, 'REAL')).out).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_NOT_TRUSTED' }); // unknown key id: rejected
    expect((await issueWith(attacker.signer, k.custody.keyRing, 'SYNTHETIC')).out).toEqual({ ok: false, kind: 'DENIED', reason: 'SIGNING_KEY_NOT_TRUSTED' });
    // the attacker claims the id of a trusted key but holds a different private key: the observation is issued, and fails the signature
    const impostor = { keyId: 'rt-v1', sign: attacker.signer.sign } as RuntimeSigner;
    const forged = await issueWith(impostor, k.custody.keyRing, 'REAL');
    if (!forged.out.ok) throw new Error(JSON.stringify(forged.out));
    const v = createObservationVerifier({ keyRing: k.custody.keyRing, clock: () => NOW });
    expect(await v.verify(forged.out.observation, expected('REAL_NETWORK'))).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    expect(await createObservationVerifier({ keyRing: k.custody.keyRing, clock: () => NOW, crossProcess: true }).verify(JSON.parse(JSON.stringify(forged.out.observation)), expected('REAL_NETWORK'))).toEqual({ ok: false, reason: 'SIGNATURE_INVALID' });
    // genuine synthetic provenance verifies only as synthetic
    const syn = await k.custody.activeSigner('SYNTHETIC_RUNTIME'); const good = await issueWith(syn, k.custody.keyRing, 'SYNTHETIC');
    if (!good.out.ok) throw new Error('issue');
    expect(await v.verify(good.out.observation, expected())).toMatchObject({ ok: true, kind: 'SYNTHETIC_RUNTIME' });
    expect(await v.verify(good.out.observation, expected('REAL_NETWORK'))).toEqual({ ok: false, reason: 'KIND_MISMATCH' });
    expect(await v.verify({ ...good.out.observation, claims: { ...good.out.observation.claims, kind: 'REAL_NETWORK' } }, expected('REAL_NETWORK'))).toMatchObject({ ok: false });
  });

  it('45. historical verification obeys the retained-key policy: valid until verifyUntil, never after revocation, never for unknown ids, and rotation keeps old evidence verifiable', async () => {
    let now = NOW; const k = custodyKeys([{ keyId: 'syn-v1', version: 1, notAfterMs: NOW + 1000, verifyUntilMs: NOW + 100_000 }], () => now);
    const old = await issueWith(await k.custody.activeSigner('SYNTHETIC_RUNTIME'), k.custody.keyRing, 'SYNTHETIC', () => now);
    if (!old.out.ok) throw new Error('issue');
    const v = createObservationVerifier({ keyRing: k.custody.keyRing, clock: () => now });
    now = NOW + 5000; // past the issuance window, inside the retention window
    expect(await v.verify(old.out.observation, expected())).toMatchObject({ ok: true });
    await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toMatchObject({ code: 'NO_VALID_KEY' }); // but it can no longer issue
    // rotation: a new version issues, the old evidence still verifies
    k.state.dir = [...k.records(), { ...k.records()[0]!, keyId: 'syn-v2', version: 2, notAfterMs: NOW + 1_000_000, verifyUntilMs: NOW + 2_000_000 }];
    k.pairs.set('syn-v2', keyPair('syn-v2')); (k.state.dir as any[])[1].publicKeyHex = k.pairs.get('syn-v2')!.publicKeyHex;
    const fresh = await k.custody.activeSigner('SYNTHETIC_RUNTIME'); expect(fresh.keyId).toBe('syn-v2');
    expect(await v.verify(old.out.observation, expected())).toMatchObject({ ok: true });
    now = NOW + 100_000; expect(await v.verify(old.out.observation, expected())).toEqual({ ok: false, reason: 'SIGNING_KEY_EXPIRED' }); // retention over
    now = NOW + 5000;
    k.state.dir = (k.state.dir as any[]).map(r => (r.keyId === 'syn-v1' ? { ...r, revokedAtMs: NOW + 2000 } : r));
    expect(await v.verify(old.out.observation, expected())).toEqual({ ok: false, reason: 'SIGNING_KEY_REVOKED' }); // revocation overrides retention
    k.state.dir = (k.state.dir as any[]).filter(r => r.keyId !== 'syn-v1');
    expect(await v.verify(old.out.observation, expected())).toEqual({ ok: false, reason: 'SIGNING_KEY_NOT_TRUSTED' }); // unknown key id
    // an unavailable or malformed directory issues nothing and verifies nothing
    k.state.down = true;
    await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME')).rejects.toBeInstanceOf(SigningCustodyError);
    expect(await v.verify(old.out.observation, expected())).toEqual({ ok: false, reason: 'SIGNING_AUTHORITY_UNAVAILABLE' });
    k.state.down = false;
    for (const bad of [{}, [{}], [{ ...k.records()[0]!, purpose: 'ANY' }], [{ ...k.records()[0]!, verifyUntilMs: 1 }], [k.records()[0], k.records()[0]], [{ ...k.records()[0]!, publicKeyHex: 'zz' }], null]) {
      k.state.dir = bad; await expect(k.custody.activeSigner('SYNTHETIC_RUNTIME'), JSON.stringify(bad)).rejects.toBeInstanceOf(SigningCustodyError);
      expect(await v.verify(old.out.observation, expected())).toMatchObject({ ok: false });
    }
  });
});

// ---- integration of the boundaries (in memory) --------------------------------------------------------------------------------------------------------------------------------------------------
describe('F. an authorized synthetic workload obtains its identity and credential, satisfies authorization and builds synthetic proof evidence that stays synthetic', () => {
  it('workload -> credential custody -> restricted transport -> synthetic runtime (custody signer) -> proof; the proof cannot verify a mapping or authorize anything real', async () => {
    const w = custodyRig(); const identity = await resolveOk(w); const src = w.custody.sourceFor(identity);
    const k = custodyKeys([{ keyId: 'syn-v1' }]); const signer = await k.custody.activeSigner(identity.signingKeyPurpose);
    const calls: string[] = [];
    const fetchImpl = (async (u: any) => { calls.push(String(u)); return new Response(JSON.stringify(String(u).endsWith('/v1/account') ? account : invoice())); }) as unknown as typeof fetch;
    const transport = createStripeGetTransport({ credentials: src, fetchImpl, clock: () => NOW });
    const gate = gateForWorkload({ authority: w.authority, identity, store: gateFor(AUTH).store, mapping: MappingRegistry.catalog() });
    const runtime = createSyntheticTrustedRuntime({ signer, keyRing: k.custody.keyRing, gate, clock: () => NOW, transport });
    const verifier = createObservationVerifier({ keyRing: k.custody.keyRing, clock: () => NOW });
    const store = createInMemoryProofStore();
    const cap = await captureProof({ runtime, verifier, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'INVOICE_RETRIEVE', invoiceId: 'in_1' });
    if (!cap.ok) throw new Error(JSON.stringify(cap));
    expect(cap.proof).toMatchObject({ captureOrigin: 'SYNTHETIC_RUNTIME', runtimeKeyId: 'syn-v1', workloadId: WORKLOAD, accountId: ACCT });
    expect(calls.map(c => c.replace('https://api.stripe.com', ''))).toEqual(['/v1/account', '/v1/invoices/in_1']);
    expect(applyProof(gate.mapping, cap.proof)).toMatchObject({ note: 'ORIGIN_CANNOT_VERIFY', changes: [] }); // synthetic evidence does not verify a mapping
    expect(w.audit.map(e => e.event)).toEqual(['credential.resolved', 'credential.resolved']);
    // a revoked workload stops the very next read, before the store and before the credential
    w.state.config = wl({ revokedAtMs: NOW - 1 }); const reads = w.st.reads.length;
    expect(await captureProof({ runtime, verifier, store, clock: () => NOW, audit: () => undefined }, { businessId: 'biz-1', accountId: ACCT, methodId: 'ACCOUNT_RETRIEVE_CURRENT' })).toEqual({ ok: false, kind: 'DENIED', reason: 'WORKLOAD_REVOKED' });
    expect(w.st.reads.length).toBe(reads); expect(calls).toHaveLength(2);
  });

  it('no module reads the environment, imports the Stripe SDK, calls fetch outside the transport or names a write verb (so no setting can widen the methods)', () => {
    const dir = resolve(__dirname);
    const files = readdirSync(dir).filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'pipeline-fixtures.ts');
    expect(files).toEqual(expect.arrayContaining(['admin-session.ts', 'read-authorization-admin.ts', 'workload-identity.ts', 'credential-custody.ts', 'signing-custody.ts']));
    for (const f of files) {
      const text = readFileSync(resolve(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/process\.env|import\.meta\.env|Deno\.env/.test(text), `${f} reads the environment`).toBe(false);
      expect(/from 'stripe'|new Stripe\(/.test(text), `${f} imports the SDK`).toBe(false);
      expect(/\bfetch\s*\(/.test(text) && f !== 'transport.ts', `${f} calls fetch`).toBe(false);
      expect(/method:\s*'(POST|PUT|PATCH|DELETE)'/i.test(text), `${f} has a write verb`).toBe(false);
    }
  });
});
