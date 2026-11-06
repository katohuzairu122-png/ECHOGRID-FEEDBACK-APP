/* eslint-disable @typescript-eslint/no-explicit-any -- request/response fixtures */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sign as honoSign } from 'hono/jwt';
import type { Bindings } from '../config/env';
import { errorHandler } from '../lib/error-handler';
import { signAccessToken, signImpersonationToken } from '../auth/jwt';
import { createStripeReadAdminRoutes, ProposalBody } from './stripe-read-admin.routes';

/**
 * S08-D1D3-DEV-12 (unit): the independent controls in front of the administrator API, and the authentication boundary as seen through HTTP. No database: the request-scoped database is a stub, so
 * anything past authentication that needs one fails closed (policy state UNKNOWN). The lifecycle itself is tested over PostgreSQL in test/integration/stripe-read-admin-api.integration.test.ts.
 */
const SECRET = 'dev12-access-secret-0123456789abcdef-zz';
const GATEWAY = 'g'.repeat(40);
const ENV = { ENVIRONMENT: 'development', JWT_ACCESS_SECRET: SECRET, INTERNAL_STRIPE_READ_ADMIN_API: 'enabled', INTERNAL_API_GATEWAY_TOKEN: GATEWAY } as unknown as Bindings;
const passthrough = createMiddleware(async (_c, next) => next());
afterEach(() => vi.restoreAllMocks());

type Row = { id: string; status: string; platformRole: string | null; isDeleted?: boolean };
function rig(over: { user?: Partial<Row> | null; live?: boolean; sessionsFor?: (u: string, s: string) => boolean; openDbThrows?: boolean; usersThrow?: boolean } = {}) {
  const userId = randomUUID(); const sid = randomUUID();
  const row: Row | undefined = over.user === null ? undefined : { id: userId, status: 'active', platformRole: 'admin', isDeleted: false, ...over.user };
  const calls = { openDb: 0 };
  const routes = createStripeReadAdminRoutes({
    limiter: passthrough as never, clock: () => Date.now(),
    openDb: async () => { calls.openDb++; if (over.openDbThrows) throw new Error('db down'); return { db: {} as never, close: async () => undefined }; },
    sessionDeps: () => ({
      accessSecret: SECRET, clock: () => Date.now(),
      users: { async findById(id: string) { if (over.usersThrow) throw new Error('db down'); return row && row.id === id ? row : undefined; } },
      sessions: { async isSessionLive(u: string, s: string) { return over.sessionsFor ? over.sessionsFor(u, s) : over.live !== false && u === userId && s === sid; } },
    }),
  });
  const seen: { userId?: string | undefined } = {};
  const app = new Hono<{ Bindings: Bindings }>(); app.onError(errorHandler);
  app.use('*', async (c, next) => { await next(); seen.userId = (c as never as { get(k: string): string | undefined }).get('userId'); }); // what the global audit trail would attribute the request to
  app.route('/internal/stripe-read', routes);
  const token = () => signAccessToken(userId, SECRET, sid);
  const call = (path: string, init: RequestInit & { env?: Partial<Bindings> | null; auth?: string | null; headers?: Record<string, string> } = {}) => {
    const { env, auth, headers, ...rest } = init;
    return app.request(`/internal/stripe-read${path}`, { ...rest, headers: { 'x-internal-gateway-token': GATEWAY, ...(auth === null ? {} : auth ? { authorization: auth } : {}), ...(headers ?? {}) } }, env === null ? undefined : ({ ...ENV, ...(env ?? {}) } as Bindings));
  };
  return { app, call, userId, sid, token, calls, seen };
}
const body = (r: Response) => r.json() as Promise<any>;
const bearer = (t: string) => `Bearer ${t}`;

describe('independent deployment controls: /internal is not the security boundary', () => {
  it('the surface does not exist unless explicitly enabled AND presented with the gateway token; refusals are indistinguishable and never touch the database', async () => {
    const r = rig(); const auth = bearer(await r.token());
    const statuses: Array<[string, Response]> = [
      ['flag unset', await r.call('/policy', { auth, env: { INTERNAL_STRIPE_READ_ADMIN_API: undefined } })],
      ['flag not enabled', await r.call('/policy', { auth, env: { INTERNAL_STRIPE_READ_ADMIN_API: 'true' } })],
      ['gateway secret unset', await r.call('/policy', { auth, env: { INTERNAL_API_GATEWAY_TOKEN: undefined } })],
      ['gateway secret too short', await r.call('/policy', { auth, env: { INTERNAL_API_GATEWAY_TOKEN: 'short' } })],
      ['short gateway secret equal to the presented value', await r.call('/policy', { auth, env: { INTERNAL_API_GATEWAY_TOKEN: 'short' }, headers: { 'x-internal-gateway-token': 'short' } })],
      ['no gateway token presented', await r.call('/policy', { auth, headers: { 'x-internal-gateway-token': '' } })],
      ['wrong gateway token', await r.call('/policy', { auth, headers: { 'x-internal-gateway-token': 'x'.repeat(40) } })],
      ['prefix of the gateway token', await r.call('/policy', { auth, headers: { 'x-internal-gateway-token': GATEWAY.slice(0, 39) } })],
    ];
    for (const [label, res] of statuses) { expect(res.status, label).toBe(404); expect(await body(res), label).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } }); expect(res.headers.get('cache-control'), label).toBe('no-store'); }
    expect(r.calls.openDb).toBe(0);
    // a valid administrator token does not make an unreachable deployment reachable, and a valid gateway token does not authenticate
    expect((await r.call('/policy', { auth: null })).status).toBe(401);
  });

  it('browser-originated requests are refused, responses are never cacheable, and only the defined verbs exist', async () => {
    const r = rig(); const auth = bearer(await r.token());
    const withOrigin = await r.call('/policy', { auth, headers: { origin: 'https://evil.example' } });
    expect(withOrigin.status).toBe(403); expect((await body(withOrigin)).error.code).toBe('FORBIDDEN_ORIGIN');
    expect(withOrigin.headers.get('access-control-allow-origin')).toBeNull();
    for (const m of ['PUT', 'PATCH', 'DELETE']) for (const p of ['/policy', '/authorizations', `/authorizations/${randomUUID()}`, `/authorizations/${randomUUID()}/approve`]) expect((await r.call(p, { method: m, auth })).status, `${m} ${p}`).toBe(404);
    expect((await r.call('/policy', { method: 'POST', auth, headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404); // no write handler for the policy
    for (const res of [await r.call('/policy', { auth }), await r.call('/policy', { auth: null }), await r.call('/nothing', { auth })]) expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('request bodies must be small JSON: other content types and oversized bodies are refused before authentication', async () => {
    const r = rig(); const auth = bearer(await r.token());
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', '']) expect((await r.call('/authorizations', { method: 'POST', auth, headers: { 'content-type': ct }, body: '{}' })).status, ct).toBe(422);
    const big = JSON.stringify({ pad: 'x'.repeat(5000) });
    const res = await r.call('/authorizations', { method: 'POST', auth, headers: { 'content-type': 'application/json' }, body: big });
    expect(res.status).toBe(422); expect((await body(res)).error.code).toBe('BODY_TOO_LARGE'); expect(r.calls.openDb).toBe(0);
  });
});

describe('1-10. administrator authentication through the HTTP boundary', () => {
  it('1-4. anonymous, invalid, expired and unbound tokens are rejected with a generic 401 that names nothing', async () => {
    const r = rig(); const past = Math.floor(Date.now() / 1000) - 3600;
    const cases: Array<[string, string | null]> = [
      ['anonymous', null], ['invalid bearer', bearer('a.b.c')], ['malformed scheme', 'Basic abc'], ['empty bearer', 'Bearer '],
      ['expired token', bearer(await honoSign({ sub: r.userId, sid: r.sid, type: 'access', iat: past - 900, exp: past }, SECRET, 'HS256'))],
      ['wrong secret', bearer(await honoSign({ sub: r.userId, sid: r.sid, type: 'access', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 }, 'another-secret-another-secret-12345', 'HS256'))],
      ['missing session binding', bearer(await signAccessToken(r.userId, SECRET))],
      ['malformed session claim', bearer(await honoSign({ sub: r.userId, sid: 'x', type: 'access', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 }, SECRET, 'HS256'))],
    ];
    for (const [label, auth] of cases) { const res = await r.call('/policy', { auth }); expect(res.status, label).toBe(401); expect(await body(res), label).toMatchObject({ error: { code: 'UNAUTHENTICATED', message: 'Authentication required.' } }); }
  });

  it('5-6. a revoked session is rejected, also while the same user has another live session', async () => {
    const r = rig({ live: false });
    expect((await r.call('/policy', { auth: bearer(await r.token()) })).status).toBe(401);
    const other = randomUUID(); // the user has a DIFFERENT live session; the token's own session is revoked
    const r2 = rig({ sessionsFor: (_u, s) => s === other });
    expect((await r2.call('/policy', { auth: bearer(await r2.token()) })).status).toBe(401);
    expect((await r2.call('/policy', { auth: bearer(await signAccessToken(r2.userId, SECRET, other)) })).status).toBe(200); // that other session works for itself only
  });

  it('7-9. non-administrators, suspended administrators and deleted administrators are rejected with 403; impersonation tokens never administer', async () => {
    for (const user of [{ platformRole: null }, { platformRole: 'support' }, { platformRole: 'billing' }, { status: 'suspended' }, { status: 'deactivated' }, { isDeleted: true }]) {
      const r = rig({ user }); const res = await r.call('/policy', { auth: bearer(await r.token()) });
      expect([res.status, (await body(res)).error.code], JSON.stringify(user)).toEqual([403, 'ADMIN_ACCESS_DENIED']);
    }
    const r = rig(); const imp = await signImpersonationToken(r.userId, randomUUID(), SECRET);
    expect((await r.call('/policy', { auth: bearer(imp.token) })).status).toBe(403);
  });

  it('10. a valid session-bound administrator is accepted, and policy status fails closed when the store cannot be read', async () => {
    const r = rig(); const res = await r.call('/policy', { auth: bearer(await r.token()) });
    expect(res.status).toBe(200);
    expect(r.seen.userId).toBe(r.userId); // the request is attributed to the SESSION administrator for the audit trail
    expect(await body(res)).toMatchObject({ success: true, data: { approvalEnabled: false, state: 'UNKNOWN', version: null, mutableThroughApi: false } });
  });

  it('authentication-storage failure fails closed with 500, and no request field names an administrator', async () => {
    const down = rig({ openDbThrows: true }); const r1 = await down.call('/policy', { auth: bearer(await down.token()) });
    expect([r1.status, (await body(r1)).error.code]).toEqual([500, 'ADMIN_AUTH_UNAVAILABLE']);
    const broken = rig({ usersThrow: true }); const r2 = await broken.call('/policy', { auth: bearer(await broken.token()) });
    expect([r2.status, (await body(r2)).error.code]).toEqual([500, 'ADMIN_AUTH_UNAVAILABLE']);
    // an administrator named in a header, query or body changes nothing: the non-admin token stays refused
    const user = rig({ user: { platformRole: null } }); const admin = randomUUID();
    const res = await user.call(`/policy?adminUserId=${admin}&isAdmin=true`, { auth: bearer(await user.token()), headers: { 'x-admin-user-id': admin, 'x-is-admin': 'true' } });
    expect(res.status).toBe(403);
  });

  it('credentials and session identifiers are never echoed in responses or logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined); const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = rig({ live: false }); const token = await r.token();
    const res = await r.call('/policy', { auth: bearer(token), headers: { 'x-request-id': 'rid' } });
    const text = JSON.stringify([await res.text(), warn.mock.calls, err.mock.calls, [...res.headers.entries()]]);
    expect(text).not.toContain(token); expect(text).not.toContain(r.sid); expect(text).not.toContain(GATEWAY);
    expect(warn).toHaveBeenCalled(); // the denial is logged, with a reason and a correlation id only
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: 'stripe_read_admin.denied', reason: 'SESSION_REVOKED', status: 401 });
  });
});

describe('11-16. proposal request validation (after authentication, before any database access)', () => {
  const valid = () => ({ businessId: randomUUID(), accountId: 'acct_Dev12Account1', methodId: 'INVOICE_RETRIEVE', realm: 'test', workloadId: 'wl-verifier-1', validFromMs: 1, expiresAtMs: Date.now() + 3_600_000, inventoryRevision: 'rev-1' });
  const post = async (r: ReturnType<typeof rig>, b: unknown, raw?: string) => r.call('/authorizations', { method: 'POST', auth: bearer(await r.token()), headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(b) });

  it('malformed bodies, unsupported methods, live realm, mass assignment and bad identifiers are rejected with 422 that never echoes submitted values', async () => {
    const r = rig();
    expect((await post(r, null, '{not json')).status).toBe(422);
    expect((await post(r, null, 'null')).status).toBe(422);
    expect((await post(r, null, '[]')).status).toBe(422);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['unsupported method REFUNDS_LIST', { methodId: 'REFUNDS_LIST' }], ['unsupported PAYMENT_RETRIEVE', { methodId: 'PAYMENT_RETRIEVE' }], ['unknown method', { methodId: 'REFUNDS_CREATE' }], ['write-shaped method', { methodId: 'POST /v1/refunds' }],
      ['live realm', { realm: 'live' }], ['missing realm', { realm: undefined }], ['wrong account type', { accountId: 'cus_123' }], ['account injection', { accountId: "acct_x'; drop table users;--" }],
      ['bad business id', { businessId: 'biz-1' }], ['bad workload', { workloadId: '../etc' }], ['negative start', { validFromMs: -1 }], ['float expiry', { expiresAtMs: 1.5 }], ['string expiry', { expiresAtMs: 'soon' }],
      ['mass assignment adminUserId', { adminUserId: randomUUID() }], ['mass assignment proposedBy', { proposedBy: randomUUID() }], ['mass assignment state', { state: 'APPROVED' }], ['mass assignment inventoryRecordId', { inventoryRecordId: 'X' }],
      ['mass assignment approvedBy', { approvedBy: randomUUID() }], ['mass assignment version', { version: 9 }], ['non-printable revision', { inventoryRevision: 'a\nb' }], ['empty revision', { inventoryRevision: '' }],
    ];
    for (const [label, patch] of bad) {
      const res = await post(r, { ...valid(), ...patch }); const b = await body(res);
      expect(res.status, label).toBe(422); expect(b.error.code, label).toBe('INVALID_REQUEST');
      expect(JSON.stringify(b), label).not.toMatch(/drop table|cus_123|REFUNDS_CREATE|\.\.\/etc/); // submitted values are not reflected
    }
    expect(ProposalBody.safeParse(valid()).success).toBe(true);
    // identifiers in the PATH are validated too
    for (const id of ['x', '1', `${randomUUID()}x`, 'null']) { expect((await r.call(`/authorizations/${id}/approve`, { method: 'POST', auth: bearer(await r.token()), headers: { 'content-type': 'application/json' }, body: '{"evidenceRef":"E"}' })).status, id).toBe(422); expect((await r.call(`/authorizations/${id}?businessId=${randomUUID()}`, { auth: bearer(await r.token()) })).status, id).toBe(422); }
    // approval / revocation bodies are strict too
    const id = randomUUID();
    for (const b of [{}, { evidenceRef: '' }, { evidenceRef: 'ok', approvedBy: randomUUID() }, { evidenceRef: 5 }, { evidenceRef: 'a b' }]) expect((await r.call(`/authorizations/${id}/approve`, { method: 'POST', auth: bearer(await r.token()), headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, JSON.stringify(b)).toBe(422);
    for (const b of [{}, { reason: 'lower' }, { reason: 'OK', revokedBy: randomUUID() }, { reason: 'X'.repeat(65) }, { reason: 7 }]) expect((await r.call(`/authorizations/${id}/revoke`, { method: 'POST', auth: bearer(await r.token()), headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, JSON.stringify(b)).toBe(422);
  });

  it('a validity interval that is inverted, empty or already expired is rejected; without a readable approval policy a well-formed proposal is refused (fail closed), not accepted', async () => {
    const r = rig();
    expect((await post(r, { ...valid(), validFromMs: 10, expiresAtMs: 10 })).status).toBe(422);
    expect((await post(r, { ...valid(), validFromMs: 100, expiresAtMs: 50 })).status).toBe(422);
    expect((await post(r, { ...valid(), validFromMs: 1, expiresAtMs: 2 })).status).toBe(422);
    const res = await post(r, valid());
    expect([res.status, (await body(res)).error.code]).toEqual([409, 'APPROVAL_POLICY_DISABLED']);
    expect((await r.call('/policy', { auth: bearer(await r.token()) })).status).toBe(200);
  });
});

describe('static properties of the administrator API module', () => {
  it('it cannot reach Stripe, secrets, signing keys, provider transport, evidence, the ledger or the policy switch', () => {
    const text = readFileSync(resolve(__dirname, 'stripe-read-admin.routes.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const imports = [...text.matchAll(/from '([^']+)'/g)].map(m => m[1]!);
    for (const i of imports) expect(i, i).not.toMatch(/transport|credential-custody|signing-custody|trusted-runtime|synthetic-runtime|proof-capture|mapping-authority|acquisition-pipeline|read-provider|evidence|partner-credit|consumption|stripe-client|webhook|settlement/);
    expect(/from 'stripe'|new Stripe\(|\bfetch\s*\(/.test(text)).toBe(false);
    expect(/process\.env|import\.meta\.env/.test(text)).toBe(false);
    expect(/set\s+approval_enabled|update\s+(public\.)?stripe_read_authorization_policy|insert\s+into\s+(public\.)?stripe_read_authorization_policy/i.test(text)).toBe(false); // no statement that writes the policy
    expect(/routes\.(put|patch|delete)\(/.test(text)).toBe(false);
    expect([...text.matchAll(/routes\.(get|post)\('([^']+)'/g)].map(m => `${m[1]} ${m[2]}`).sort()).toEqual(['get /authorizations/:id', 'get /authorizations/:id/audit', 'get /policy', 'get /policy/audit', 'get /policy/changes', 'get /policy/changes/:id', 'get /policy/changes/:id/audit', 'post /authorizations', 'post /authorizations/:id/approve', 'post /authorizations/:id/revoke', 'post /policy/changes', 'post /policy/changes/:id/approve', 'post /policy/changes/:id/cancel', 'post /policy/changes/:id/reject']);
  });
});

describe('DEV-13 policy administration routes: validation and the absence of any activation path', () => {
  const post = async (r: ReturnType<typeof rig>, path: string, b: unknown, raw?: string) => r.call(path, { method: 'POST', auth: bearer(await r.token()), headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(b) });
  const valid = () => ({ targetState: true, expectedVersion: 1, justification: 'Owner review of the approval policy', expiresAtMs: Date.now() + 3_600_000 });

  it('malformed proposals, mass assignment and bad decision bodies are rejected with 422 that echoes no submitted value', async () => {
    const r = rig();
    for (const raw of ['{not json', 'null', '[]', '"x"']) expect((await post(r, '/policy/changes', null, raw)).status, raw).toBe(422);
    const bad: Array<[string, Record<string, unknown>]> = [
      ['target as string', { targetState: 'true' }], ['missing target', { targetState: undefined }], ['version zero', { expectedVersion: 0 }], ['version float', { expectedVersion: 1.5 }], ['version string', { expectedVersion: '1' }],
      ['empty justification', { justification: '' }], ['control characters', { justification: 'a\nb' }], ['too long', { justification: 'x'.repeat(256) }], ['past expiry', { expiresAtMs: 5 }], ['mass assignment adminUserId', { adminUserId: randomUUID() }],
      ['mass assignment state', { state: 'APPROVED' }], ['mass assignment proposedBy', { proposedBy: randomUUID() }], ['mass assignment approvalEnabled', { approvalEnabled: true }], ['mass assignment decidedBy', { decidedBy: randomUUID() }],
    ];
    for (const [label, patch] of bad) { const res = await post(r, '/policy/changes', { ...valid(), ...patch }); expect(res.status, label).toBe(422); expect(JSON.stringify(await body(res)), label).not.toMatch(/Owner review|x{20}/); }
    const id = randomUUID();
    for (const action of ['approve', 'reject', 'cancel']) {
      for (const b of [{}, { decisionRef: '' }, { decisionRef: 'a b' }, { decisionRef: 'ok', decidedBy: randomUUID() }, { decisionRef: 5 }, { decisionRef: 'ok', state: 'APPROVED' }]) expect((await post(r, `/policy/changes/${id}/${action}`, b)).status, `${action} ${JSON.stringify(b)}`).toBe(422);
    }
    for (const q of ['limit=0', 'limit=101', 'limit=x', 'afterSeq=-1', 'extra=1']) { expect((await r.call(`/policy/changes?${q}`, { auth: bearer(await r.token()) })).status, q).toBe(422); expect((await r.call(`/policy/audit?${q}`, { auth: bearer(await r.token()) })).status, q).toBe(422); expect((await r.call(`/policy/changes/${id}/audit?${q}`, { auth: bearer(await r.token()) })).status, q).toBe(422); }
    for (const x of ['x', '1', `${id}x`]) expect((await r.call(`/policy/changes/${x}`, { auth: bearer(await r.token()) })).status, x).toBe(422);
  });

  it('every policy route needs an administrator: anonymous is 401 and a non-administrator is 403, before any validation or database access', async () => {
    const anon = rig(); const user = rig({ user: { platformRole: null } }); const id = randomUUID();
    const calls: Array<[string, string]> = [['GET', '/policy'], ['GET', '/policy/audit'], ['GET', '/policy/changes'], ['POST', '/policy/changes'], ['GET', `/policy/changes/${id}`], ['GET', `/policy/changes/${id}/audit`], ['POST', `/policy/changes/${id}/approve`], ['POST', `/policy/changes/${id}/reject`], ['POST', `/policy/changes/${id}/cancel`]];
    for (const [m, p] of calls) {
      expect((await anon.call(p, { method: m, auth: null, ...(m === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })).status, `anon ${m} ${p}`).toBe(401);
      expect((await user.call(p, { method: m, auth: bearer(await user.token()), ...(m === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })).status, `user ${m} ${p}`).toBe(403);
    }
    expect(anon.calls.openDb + user.calls.openDb).toBeGreaterThan(0); expect(user.calls.openDb).toBeGreaterThan(0);
  });

  it('there is no activation route and no env-style switch: every enabling verb and path answers 404, and a configured environment flag changes nothing', async () => {
    const r = rig(); const auth = bearer(await r.token()); const id = randomUUID();
    const paths = ['/policy/activate', '/policy/enable', '/policy/apply', '/policy/approval', '/policy/enabled', `/policy/changes/${id}/activate`, `/policy/changes/${id}/apply`, `/policy/changes/${id}/enable`];
    for (const p of paths) for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'GET']) expect((await r.call(p, { method: m, auth, ...(m === 'POST' || m === 'PUT' || m === 'PATCH' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalEnabled: true, enabled: true }) } : {}) })).status, `${m} ${p}`).toBe(404);
    for (const m of ['PUT', 'PATCH', 'DELETE']) for (const p of ['/policy', '/policy/changes', `/policy/changes/${id}`]) expect((await r.call(p, { method: m, auth })).status, `${m} ${p}`).toBe(404);
    const flagged = await r.call('/policy', { auth, env: { APPROVAL_ENABLED: 'true', STRIPE_READ_APPROVAL_ENABLED: 'true', INTERNAL_APPROVAL_ENABLED: 'true' } as never });
    expect(await body(flagged)).toMatchObject({ data: { approvalEnabled: false, mutableThroughApi: false } });
  });
});
