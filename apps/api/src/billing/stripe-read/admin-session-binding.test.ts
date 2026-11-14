/* eslint-disable @typescript-eslint/no-explicit-any -- forgery tests deliberately build malformed objects */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sign as honoSign } from 'hono/jwt';
import { AuthService } from '../../auth/auth.service';
import { createDirectPbkdf2Worker } from '../../auth/pbkdf2-worker';
import { signAccessToken, verifyAccessToken, SESSION_ID_PATTERN } from '../../auth/jwt';
import type { User } from '../../repositories/user.repository';
import type { RefreshToken, NewRefreshToken } from '../../repositories/refresh-token.repository';
import { authenticateAdminSession, createSessionRevalidator, isTrustedAdminContext, type AdminSessionDeps, type TrustedAdminContext } from './index';

/**
 * S08-D1D3-DEV-11-R1: session-specific revocation. The REAL AuthService (issue, refresh, logout) runs over in-memory repositories that implement the same session contract as the persisted
 * `refresh_tokens` repository, and the administrator boundary validates the exact session each access token is bound to. Everything is synthetic.
 */
const ACCESS = 'r1-access-secret-0123456789abcdef-aaaa';
const REFRESH = 'r1-refresh-secret-0123456789abcdef-bbbb';

function world() {
  const users = new Map<string, User>(); const rows = new Map<string, RefreshToken>(); let isLiveCalls = 0;
  const repos: any = {
    users: {
      async findByEmail(email: string) { return [...users.values()].find(u => u.email === email); },
      async findById(id: string) { const u = users.get(id); return u && !u.isDeleted ? u : undefined; },
      async create(i: any): Promise<User> { const u = { id: crypto.randomUUID(), email: i.email, emailVerifiedAt: null, passwordHash: i.passwordHash, fullName: i.fullName, phone: null, platformRole: null, status: i.status ?? 'active', lastLoginAt: null, createdAt: new Date(), createdBy: null, updatedAt: new Date(), updatedBy: null, isDeleted: false, deletedAt: null, deletedBy: null } as User; users.set(u.id, u); return u; },
      async touchLastLogin() { /* not needed */ },
    },
    refreshTokens: {
      async create(i: NewRefreshToken): Promise<RefreshToken> { const r = { id: i.id as string, userId: i.userId, tokenHash: i.tokenHash, sessionId: i.sessionId ?? null, issuedAt: new Date(), expiresAt: i.expiresAt, revokedAt: null, replacedByTokenId: null, userAgent: null, ipAddress: null, client: i.client ?? 'web', businessId: null, branchId: null, deviceLabel: null } as RefreshToken; rows.set(r.id, r); return r; },
      async findById(id: string) { return rows.get(id); },
      async rotate(id: string, by: string) { const r = rows.get(id); if (!r || r.revokedAt) return false; r.revokedAt = new Date(); r.replacedByTokenId = by; return true; },
      async revoke(id: string) { const r = rows.get(id); if (r) r.revokedAt = new Date(); },
      async revokeSession(userId: string, sid: string) { const m = [...rows.values()].filter(r => r.userId === userId && r.sessionId === sid && !r.revokedAt); m.forEach(r => (r.revokedAt = new Date())); return m.length; },
      async isSessionLive(userId: string, sid: string, nowMs: number) { isLiveCalls++; return [...rows.values()].some(r => r.userId === userId && r.sessionId === sid && !r.revokedAt && r.expiresAt.getTime() > nowMs); },
      async revokeAllForUser(userId: string) { const m = [...rows.values()].filter(r => r.userId === userId && !r.revokedAt); m.forEach(r => (r.revokedAt = new Date())); return m.length; },
      async listActiveForUser(userId: string) { return [...rows.values()].filter(r => r.userId === userId && !r.revokedAt); },
    },
    passwordResetTokens: {},
  };
  const auth = new AuthService(repos, { JWT_ACCESS_SECRET: ACCESS, JWT_REFRESH_SECRET: REFRESH }, createDirectPbkdf2Worker());
  const deps = (clock: () => number = () => Date.now()): AdminSessionDeps => ({ accessSecret: ACCESS, users: repos.users, sessions: repos.refreshTokens, clock });
  let n = 0;
  /** A user with a password, a given platform role and status, who logs in (a NEW session each time). */
  async function user(role: string | null = 'admin', status = 'active') {
    const email = `r1-${++n}-${randomUUID()}@example.test`;
    const t = await auth.signup({ email, password: 'correct horse battery staple', fullName: 'R1' });
    const u = [...users.values()].find(x => x.email === email)!; u.platformRole = role as any; u.status = status;
    return { id: u.id, email, signupTokens: t, row: u };
  }
  const login = (email: string) => auth.login({ email, password: 'correct horse battery staple' });
  const sidOf = async (token: string) => (await verifyAccessToken(token, ACCESS)).sid;
  const bearer = (t: string) => `Bearer ${t}`;
  const jtiRow = async (refreshToken: string) => { const p = JSON.parse(Buffer.from(refreshToken.split('.')[1]!, 'base64url').toString()); return rows.get(p.jti)!; };
  return { repos, auth, users, rows, deps, user, login, sidOf, bearer, jtiRow, isLive: () => isLiveCalls };
}

describe('1-14. administrator authority is bound to the exact persisted session', () => {
  it('1. a valid session-bound administrator token succeeds, and the context carries a stable opaque session id', async () => {
    const w = world(); const a = await w.user();
    const t = await w.login(a.email);
    const sid = await w.sidOf(t.accessToken);
    expect(sid).toMatch(SESSION_ID_PATTERN); expect(SESSION_ID_PATTERN.test('x')).toBe(false);
    const out = await authenticateAdminSession(w.deps(), w.bearer(t.accessToken));
    if (!out.ok) throw new Error(out.reason);
    expect(out.context).toMatchObject({ adminUserId: a.id, origin: 'SERVER_SESSION' }); expect(out.context.sessionId).toMatch(/^[0-9a-f]{32}$/); expect(JSON.stringify(out.context)).not.toContain(sid!);
    // the id is unpredictable: distinct logins get distinct sessions
    const t2 = await w.login(a.email); expect(await w.sidOf(t2.accessToken)).not.toBe(sid);
    const out2 = await authenticateAdminSession(w.deps(), w.bearer(t2.accessToken)); if (!out2.ok) throw new Error(out2.reason);
    expect(out2.context.sessionId).not.toBe(out.context.sessionId); // two sessions of one administrator are two distinct contexts
    // the verifier itself rejects a malformed session claim, independently of the administrator boundary
    for (const bad of ['x', '12345678-1234-1234-1234-123456789012', 5, [], null]) await expect(verifyAccessToken(await honoSign({ sub: a.id, type: 'access', sid: bad, iat: 1, exp: Math.floor(Date.now() / 1000) + 600 }, ACCESS, 'HS256'), ACCESS), String(bad)).rejects.toThrow();
  });

  it('2. a token without a session binding (legacy) is denied for privileged actions, yet ordinary verification of it is unchanged', async () => {
    const w = world(); const a = await w.user();
    const legacy = await signAccessToken(a.id, ACCESS); // the pre-binding shape
    expect(await authenticateAdminSession(w.deps(), w.bearer(legacy))).toEqual({ ok: false, reason: 'SESSION_BINDING_MISSING' });
    expect((await verifyAccessToken(legacy, ACCESS)).sub).toBe(a.id); // the ordinary authenticate path still accepts it: nonprivileged behaviour is preserved
    const imp = await honoSign({ sub: a.id, type: 'access', iat: 1, exp: Math.floor(Date.now() / 1000) + 600 }, ACCESS, 'HS256');
    expect(await authenticateAdminSession(w.deps(), w.bearer(imp))).toEqual({ ok: false, reason: 'SESSION_BINDING_MISSING' });
  });

  it('3. a forged session identifier is denied: tampered claim, wrong secret, malformed values, an unknown session, and a session id offered outside the signed token', async () => {
    const w = world(); const a = await w.user(); const t = await w.login(a.email);
    const [h, p, s] = t.accessToken.split('.'); const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    const tamper = (sid: unknown) => `${h}.${Buffer.from(JSON.stringify({ ...payload, sid })).toString('base64url')}.${s}`;
    for (const sid of [randomUUID(), 'x', 5, [], {}, null]) expect(await authenticateAdminSession(w.deps(), w.bearer(tamper(sid))), String(JSON.stringify(sid))).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = (sid: unknown, secret = ACCESS) => honoSign({ sub: a.id, type: 'access', sid, iat: 1, exp }, secret, 'HS256');
    expect(await authenticateAdminSession(w.deps(), w.bearer(await sig(randomUUID(), 'another-secret-another-secret-123')))).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    for (const bad of ['x', '12345678-1234-1234-1234-123456789012', 5, [], null]) expect(await authenticateAdminSession(w.deps(), w.bearer(await sig(bad))), String(bad)).toEqual({ ok: false, reason: 'INVALID_TOKEN' });
    expect(await authenticateAdminSession(w.deps(), w.bearer(await sig(randomUUID())))).toEqual({ ok: false, reason: 'SESSION_REVOKED' }); // validly signed, but no such session
    // a session id is not a parameter of the boundary: the only input is the Authorization header
    expect(authenticateAdminSession.length).toBe(2);
    expect(await authenticateAdminSession(w.deps(), w.bearer(await signAccessToken(a.id, ACCESS)))).toEqual({ ok: false, reason: 'SESSION_BINDING_MISSING' });
    expect(() => signAccessToken(a.id, ACCESS, 'not-a-session')).rejects.toThrow();
  });

  it('4. expired sessions are denied: an expired access token, an expired session record, and the injected clock past both', async () => {
    const w = world(); const a = await w.user(); const t = await w.login(a.email);
    const past = Math.floor(Date.now() / 1000) - 3600; const sid = (await w.sidOf(t.accessToken))!;
    const expiredTok = await honoSign({ sub: a.id, sid, type: 'access', iat: past - 900, exp: past }, ACCESS, 'HS256');
    expect(await authenticateAdminSession(w.deps(), w.bearer(expiredTok))).toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
    (await w.jtiRow(t.refreshToken)).expiresAt = new Date(Date.now() - 1000); // the session record itself has expired
    expect(await authenticateAdminSession(w.deps(), w.bearer(t.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    const w2 = world(); const b = await w2.user(); const t2 = await w2.login(b.email);
    expect(await authenticateAdminSession(w2.deps(() => Date.now() + 16 * 60_000), w2.bearer(t2.accessToken))).toEqual({ ok: false, reason: 'SESSION_EXPIRED' });
  });

  it('5-6. a revoked session is denied, and another live session of the SAME user does not preserve its authority', async () => {
    const w = world(); const a = await w.user();
    const s1 = await w.login(a.email); const s2 = await w.login(a.email); // two live sessions
    expect((await authenticateAdminSession(w.deps(), w.bearer(s1.accessToken))).ok).toBe(true);
    expect((await authenticateAdminSession(w.deps(), w.bearer(s2.accessToken))).ok).toBe(true);
    await w.repos.refreshTokens.revoke((await w.jtiRow(s1.refreshToken)).id); // revoke ONLY session 1
    expect(await authenticateAdminSession(w.deps(), w.bearer(s1.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' }); // 5
    expect((await w.repos.refreshTokens.listActiveForUser(a.id)).length).toBeGreaterThanOrEqual(2); // the user still has live sessions (signup and s2) ...
    expect((await authenticateAdminSession(w.deps(), w.bearer(s2.accessToken))).ok).toBe(true); // ... which authorizes only its own token (6)
    expect(await authenticateAdminSession(w.deps(), w.bearer(s1.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
  });

  it("7-8. another administrator's session cannot validate the token, and a user/session mismatch is denied", async () => {
    const w = world(); const a = await w.user(); const b = await w.user();
    const ta = await w.login(a.email); const tb = await w.login(b.email);
    const sidB = (await w.sidOf(tb.accessToken))!;
    const crossed = await signAccessToken(a.id, ACCESS, sidB); // a validly signed token naming A but B's live session
    expect(await authenticateAdminSession(w.deps(), w.bearer(crossed))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    const crossed2 = await signAccessToken(b.id, ACCESS, (await w.sidOf(ta.accessToken))!);
    expect(await authenticateAdminSession(w.deps(), w.bearer(crossed2))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    expect((await authenticateAdminSession(w.deps(), w.bearer(ta.accessToken))).ok && (await authenticateAdminSession(w.deps(), w.bearer(tb.accessToken))).ok).toBe(true);
  });

  it('9. token refresh keeps the session binding: the same session id, the old row rotated out, the new token live; a legacy row receives a session id at its first refresh', async () => {
    const w = world(); const a = await w.user(); const t1 = await w.login(a.email);
    const sid = await w.sidOf(t1.accessToken);
    const t2 = await w.auth.refresh(t1.refreshToken);
    expect(await w.sidOf(t2.accessToken)).toBe(sid); expect((await w.jtiRow(t2.refreshToken)).sessionId).toBe(sid);
    expect((await w.jtiRow(t1.refreshToken)).revokedAt).not.toBeNull();
    const o2 = await authenticateAdminSession(w.deps(), w.bearer(t2.accessToken)); if (!o2.ok) throw new Error(o2.reason);
    const o1 = await authenticateAdminSession(w.deps(), w.bearer(t1.accessToken)); if (!o1.ok) throw new Error(o1.reason);
    expect(o1.context.sessionId).toBe(o2.context.sessionId); // one session across rotations
    const t3 = await w.auth.refresh(t2.refreshToken); expect(await w.sidOf(t3.accessToken)).toBe(sid);
    // legacy: a row created before the binding (no session id) mints one on refresh, and only then does administrative authority exist
    const legacyRow = await w.jtiRow(t3.refreshToken); legacyRow.sessionId = null;
    expect(await authenticateAdminSession(w.deps(), w.bearer(t3.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    const t4 = await w.auth.refresh(t3.refreshToken); const sid4 = await w.sidOf(t4.accessToken);
    expect(sid4).toMatch(SESSION_ID_PATTERN); expect(sid4).not.toBe(sid); expect((await w.jtiRow(t4.refreshToken)).sessionId).toBe(sid4);
    expect((await authenticateAdminSession(w.deps(), w.bearer(t4.accessToken))).ok).toBe(true);
  });

  it('10-11. logout and refresh-token revocation (single, revoke-all, replay containment) invalidate the session authority immediately', async () => {
    const w = world(); const a = await w.user();
    const t = await w.login(a.email); const other = await w.login(a.email);
    expect((await authenticateAdminSession(w.deps(), w.bearer(t.accessToken))).ok).toBe(true);
    await w.auth.logout(t.refreshToken); // 10
    expect(await authenticateAdminSession(w.deps(), w.bearer(t.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    expect(await w.auth.logout(t.refreshToken)).toBeUndefined(); // idempotent
    // logout presented with a ROTATED (superseded) refresh token still ends the whole session, not just the already-dead row
    const c = await w.user(); const c1 = await w.login(c.email); const c2 = await w.auth.refresh(c1.refreshToken);
    expect((await authenticateAdminSession(w.deps(), w.bearer(c2.accessToken))).ok).toBe(true);
    await w.auth.logout(c1.refreshToken);
    expect(await authenticateAdminSession(w.deps(), w.bearer(c2.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    expect((await authenticateAdminSession(w.deps(), w.bearer(other.accessToken))).ok).toBe(true); // the other session is untouched
    await expect(w.auth.refresh(t.refreshToken)).rejects.toThrow(); // a logged-out session cannot be refreshed back to life
    expect(await authenticateAdminSession(w.deps(), w.bearer(t.accessToken))).toMatchObject({ ok: false });
    await w.repos.refreshTokens.revokeAllForUser(a.id); // 11: revoke-all (password change)
    expect(await authenticateAdminSession(w.deps(), w.bearer(other.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    // replay containment: a replayed rotated refresh token kills every session, including the attacker's replacement
    const b = await w.user(); const b1 = await w.login(b.email); const b2 = await w.auth.refresh(b1.refreshToken);
    (await w.jtiRow(b1.refreshToken)).revokedAt = new Date(Date.now() - 60_000); // outside the concurrent-refresh grace window
    await expect(w.auth.refresh(b1.refreshToken)).rejects.toThrow();
    expect(await authenticateAdminSession(w.deps(), w.bearer(b2.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
  });

  it('12-14. suspended, deactivated, deleted and non-administrator users are denied even with a live, bound session', async () => {
    const w = world();
    for (const [role, status, expected] of [['admin', 'suspended', 'ACCOUNT_NOT_ACTIVE'], ['admin', 'deactivated', 'ACCOUNT_NOT_ACTIVE'], [null, 'active', 'NOT_PLATFORM_ADMIN'], ['support', 'active', 'NOT_PLATFORM_ADMIN'], ['billing', 'active', 'NOT_PLATFORM_ADMIN']] as const) {
      const u = await w.user('admin'); const t = await w.login(u.email);
      u.row.platformRole = role as any; u.row.status = status;
      expect(await authenticateAdminSession(w.deps(), w.bearer(t.accessToken)), `${role}/${status}`).toEqual({ ok: false, reason: expected });
    }
    const d = await w.user('admin'); const td = await w.login(d.email); d.row.isDeleted = true;
    expect(await authenticateAdminSession(w.deps(), w.bearer(td.accessToken))).toEqual({ ok: false, reason: 'ACCOUNT_NOT_FOUND' });
  });

  it('edge: concurrent refresh of one token keeps exactly one live row in the session; refresh racing logout cannot resurrect the session; replayed access tokens die with the session', async () => {
    const w = world(); const a = await w.user(); const t = await w.login(a.email); const sid = (await w.sidOf(t.accessToken))!;
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => w.auth.refresh(t.refreshToken)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const live = [...w.rows.values()].filter(r => r.sessionId === sid && !r.revokedAt); expect(live).toHaveLength(1);
    const winner = (results.find(r => r.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
    expect((await authenticateAdminSession(w.deps(), w.bearer(winner.accessToken))).ok).toBe(true);
    const [lo, rf] = await Promise.allSettled([w.auth.logout(winner.refreshToken), w.auth.refresh(winner.refreshToken)]);
    void lo; void rf;
    // logout revokes the whole SESSION (every row with its id), so a refresh that raced it cannot leave a live row behind, whichever order the two took
    expect(await w.repos.refreshTokens.isSessionLive(a.id, sid, Date.now())).toBe(false);
    expect(await authenticateAdminSession(w.deps(), w.bearer(winner.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' });
    expect(await authenticateAdminSession(w.deps(), w.bearer(winner.accessToken))).toEqual({ ok: false, reason: 'SESSION_REVOKED' }); // replay: still denied
  });
});

describe('use-time re-verification: a context is a point-in-time proof', () => {
  async function ctxFor(w: ReturnType<typeof world>, a: { id: string; email: string }, clock?: () => number) {
    const t = await w.login(a.email); const o = await authenticateAdminSession(w.deps(clock), w.bearer(t.accessToken)); if (!o.ok) throw new Error(o.reason);
    return { ctx: o.context, t };
  }
  it('the revalidator answers LIVE only while the exact session, the access token and the administrator are all still valid', async () => {
    const w = world(); const a = await w.user(); const other = await w.login(a.email);
    const reval = createSessionRevalidator(w.deps());
    const { ctx, t } = await ctxFor(w, a);
    expect(await reval(ctx)).toBe('LIVE');
    await w.auth.logout(t.refreshToken);
    expect(await reval(ctx)).toBe('SESSION_REVOKED'); // revoked AFTER the context was minted
    expect((await authenticateAdminSession(w.deps(), w.bearer(other.accessToken))).ok).toBe(true); // another live session does not help
    const { ctx: c2 } = await ctxFor(w, a); (w.users.get(a.id)!).platformRole = null; expect(await reval(c2)).toBe('NOT_PLATFORM_ADMIN'); w.users.get(a.id)!.platformRole = 'admin' as any;
    w.users.get(a.id)!.status = 'suspended'; expect(await reval(c2)).toBe('ACCOUNT_NOT_ACTIVE'); w.users.get(a.id)!.status = 'active';
    expect(await reval(c2)).toBe('LIVE');
    expect(await createSessionRevalidator(w.deps(() => Date.now() + 16 * 60_000))(c2)).toBe('TOKEN_EXPIRED');
  });

  it('forged, cloned and non-context values are never LIVE; repository failures fail closed', async () => {
    const w = world(); const a = await w.user(); const { ctx } = await ctxFor(w, a); const reval = createSessionRevalidator(w.deps());
    for (const f of [{ ...ctx }, structuredClone(ctx), Object.create(ctx), JSON.parse(JSON.stringify(ctx)), { adminUserId: a.id }, a.id, null, undefined, 5])
      expect(await reval(f)).toBe('NOT_A_TRUSTED_CONTEXT');
    expect(isTrustedAdminContext(ctx)).toBe(true);
    const down = createSessionRevalidator({ ...w.deps(), sessions: { async isSessionLive() { throw new Error('db down'); } } });
    expect(await down(ctx)).toBe('VERIFICATION_UNAVAILABLE');
    const down2 = createSessionRevalidator({ ...w.deps(), users: { async findById() { throw new Error('db down'); } } });
    expect(await down2(ctx)).toBe('VERIFICATION_UNAVAILABLE');
    expect(await createSessionRevalidator({ ...w.deps(), clock: () => NaN })(ctx)).toBe('VERIFICATION_UNAVAILABLE');
    void ({} as TrustedAdminContext);
  });
});
