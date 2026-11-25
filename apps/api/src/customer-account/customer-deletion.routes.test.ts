import { describe, expect, it, vi } from 'vitest';
import { createCustomerDeletionRoutes, type CustomerDeletionDeps } from './customer-deletion.routes';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-25T10:00:00Z');
const row = (over = {}) => ({ id: 'r1', customerId: ID, status: 'pending', requestedAt: NOW, scheduledFor: new Date('2026-12-25T10:00:00Z'), cancelledAt: null, ...over });

function build(over: { identity?: unknown; pending?: unknown; created?: boolean; cancelled?: unknown } = {}) {
  const identity = 'identity' in over ? over.identity : { assurance: 'session', customerId: ID, sessionId: 's1', authMethod: 'otp', stepUpVerifiedAt: NOW };
  const deps = {
    sessions: { authenticateSessionToken: vi.fn(async () => identity), logoutAll: vi.fn(async () => ({ revoked: 2 })) },
    requests: {
      findPending: vi.fn(async () => over.pending ?? null),
      fileOrGetPending: vi.fn(async () => ({ request: row(), created: over.created ?? true })),
      cancelPending: vi.fn(async () => over.cancelled ?? null),
    },
    audit: { record: vi.fn(async () => undefined) },
    reauthenticate: vi.fn(async () => true),
    allowReauthentication: vi.fn(async () => true),
    stepUpWindowSeconds: 300,
    clock: () => NOW,
  };
  const app = createCustomerDeletionRoutes(deps as unknown as CustomerDeletionDeps);
  const call = (method: string, path: string, auth = true, body?: unknown) =>
    app.request(path, { method, headers: { ...(auth ? { authorization: 'Bearer tok' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { deps, call };
}

describe('customer deletion routes', () => {
  it('every route needs a live session: no header and a legacy token are both 401', async () => {
    const { call } = build();
    for (const [m, p] of [['GET', '/deletion'], ['POST', '/deletion'], ['POST', '/deletion/restore']] as const) {
      expect((await call(m, p, false)).status).toBe(401);
    }
    const legacy = build({ identity: { assurance: 'legacy', customerId: ID } });
    expect((await legacy.call('POST', '/deletion')).status).toBe(401);
    expect(legacy.deps.requests.fileOrGetPending).not.toHaveBeenCalled();
  });

  it('password reauthentication records fresh step-up without filing or signing out', async () => {
    const { call, deps } = build({ identity: { assurance: 'session', customerId: ID, sessionId: 's', authMethod: 'password', stepUpVerifiedAt: null } });
    const res = await call('POST', '/deletion/reauth', true, { currentPassword: 'correct password' });
    expect(res.status).toBe(204);
    expect(deps.reauthenticate).toHaveBeenCalledWith(ID, 's', 'correct password');
    expect(deps.requests.fileOrGetPending).not.toHaveBeenCalled();
    expect(deps.sessions.logoutAll).not.toHaveBeenCalled();
  });

  it('reauthentication fails closed for wrong password, exhausted budget and legacy/OTP sessions', async () => {
    const a = build({ identity: { assurance: 'session', customerId: ID, sessionId: 's', authMethod: 'password', stepUpVerifiedAt: null } });
    a.deps.reauthenticate.mockResolvedValueOnce(false);
    expect((await a.call('POST', '/deletion/reauth', true, { currentPassword: 'bad password' })).status).toBe(401);
    a.deps.allowReauthentication.mockResolvedValueOnce(false);
    expect((await a.call('POST', '/deletion/reauth', true, { currentPassword: 'bad password' })).status).toBe(429);
    expect(a.deps.reauthenticate).toHaveBeenCalledTimes(1);
    const legacy = build({ identity: { assurance: 'legacy', customerId: ID } });
    expect((await legacy.call('POST', '/deletion/reauth', true, { currentPassword: 'pw' })).status).toBe(401);
    const otp = build();
    expect((await otp.call('POST', '/deletion/reauth', true, { currentPassword: 'pw' })).status).toBe(401);
  });

  it('rejects malformed password confirmation before rate-limit or credential work', async () => {
    const t = build({ identity: { assurance: 'session', customerId: ID, sessionId: 's', authMethod: 'password', stepUpVerifiedAt: null } });
    expect((await t.call('POST', '/deletion/reauth', true, { currentPassword: '', other: 'x' })).status).toBe(400);
    expect(t.deps.allowReauthentication).not.toHaveBeenCalled();
    expect(t.deps.reauthenticate).not.toHaveBeenCalled();
  });

  it('filing without a fresh step-up is refused and nothing is written', async () => {
    const stale = new Date(NOW.getTime() - 10 * 60_000);
    const { call, deps } = build({ identity: { assurance: 'session', customerId: ID, sessionId: 's', authMethod: 'password', stepUpVerifiedAt: stale } });
    const res = await call('POST', '/deletion');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
    expect(deps.requests.fileOrGetPending).not.toHaveBeenCalled();
    expect(deps.sessions.logoutAll).not.toHaveBeenCalled();
  });

  it('a password session that never stepped up is also refused', async () => {
    const { call } = build({ identity: { assurance: 'session', customerId: ID, sessionId: 's', authMethod: 'password', stepUpVerifiedAt: null } });
    expect((await call('POST', '/deletion')).status).toBe(403);
  });

  it('filing creates the request, signs every device out and writes one audit event', async () => {
    const { call, deps } = build();
    const res = await call('POST', '/deletion');
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ status: 'pending', scheduledFor: '2026-12-25T10:00:00.000Z' });
    expect(deps.sessions.logoutAll).toHaveBeenCalledWith({ customerId: ID });
    expect(deps.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.deletion_requested', entityId: ID, actorUserId: null }));
  });

  it('filing again while pending is idempotent: 200, no second sign-out, no second audit row', async () => {
    const { call, deps } = build({ created: false });
    expect((await call('POST', '/deletion')).status).toBe(200);
    expect(deps.sessions.logoutAll).not.toHaveBeenCalled();
    expect(deps.audit.record).not.toHaveBeenCalled();
  });

  it('a failing audit write never fails the request', async () => {
    const { call, deps } = build();
    deps.audit.record.mockRejectedValueOnce(new Error('db'));
    expect((await call('POST', '/deletion')).status).toBe(201);
  });

  it('status reports none or the pending date', async () => {
    expect(await (await build().call('GET', '/deletion')).json()).toEqual({ status: 'none' });
    expect(await (await build({ pending: row() }).call('GET', '/deletion')).json()).toMatchObject({ status: 'pending' });
  });

  it('restore cancels a pending request and audits it; with nothing pending it is 404', async () => {
    const ok = build({ cancelled: row({ status: 'cancelled' }) });
    expect(await (await ok.call('POST', '/deletion/restore')).json()).toEqual({ status: 'restored' });
    expect(ok.deps.audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'customer.deletion_restored' }));
    const none = build();
    const res = await none.call('POST', '/deletion/restore');
    expect(res.status).toBe(404);
    expect(none.deps.audit.record).not.toHaveBeenCalled();
  });

  it('an unexpected failure is a generic 503 with no detail', async () => {
    const { call, deps } = build();
    deps.requests.findPending.mockRejectedValueOnce(new Error('secret db detail'));
    const res = await call('GET', '/deletion');
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('secret');
  });
});
