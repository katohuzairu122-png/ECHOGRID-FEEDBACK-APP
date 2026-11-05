import { SESSION_ID_PATTERN, verifyAccessToken } from '../../auth/jwt';
import { sha256Hex } from './bundle-builder';

/**
 * S08-D1D3-DEV-11: the ADMINISTRATOR SESSION boundary. It reuses ECHO GRID's existing identity infrastructure (the HS256 access token verified by `verifyAccessToken`, the `users` table and the `refresh_tokens`
 * session records); there is no second authentication provider.
 *
 * `authenticateAdminSession` is the ONLY way to obtain a `TrustedAdminContext`. It verifies the bearer token server-side, resolves the administrator from the persisted `users` row (never from a token claim or
 * a caller-supplied id), requires `status = 'active'`, `platform_role = 'admin'` and not deleted, rejects impersonation tokens, and requires a live (unrevoked, unexpired) session record, so a logout or a
 * password-change revocation takes effect immediately instead of at access-token expiry. Every uncertainty (a failing repository, a malformed row) denies.
 *
 * The context is a frozen object registered in a module-private WeakSet and carrying a non-exported brand: an object literal, a clone or a spread is not a context, and no export constructs one. Lifecycle
 * services accept only a context, never an administrator id, and re-check its age (`requireFreshAdmin`) so a stale context cannot be replayed later. The database re-verifies the administrator on every
 * transition (DEV-10 guard), so this boundary is defence in depth, not the only gate.
 */
declare const BRAND: unique symbol;
export const ADMIN_SCOPE = 'platform:stripe-read-authorization' as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TrustedAdminContext {
  readonly [BRAND]: true;
  readonly adminUserId: string;
  /** Opaque identifier of the verified session: a digest of the verified access token, never the token. */
  readonly sessionId: string;
  readonly verifiedAtMs: number;
  readonly scope: typeof ADMIN_SCOPE;
  readonly assurance: Readonly<{ method: 'ACCESS_TOKEN_HS256'; impersonated: false; liveSession: true }>;
  readonly origin: 'SERVER_SESSION';
}
const minted = new WeakSet<object>();
/** Private to this module: the exact persisted session and the token expiry a context was minted from, used to RE-VERIFY it at every privileged call. Nothing exports it. */
const bindings = new WeakMap<object, Readonly<{ userId: string; sessionId: string; tokenExpMs: number }>>();
export const isTrustedAdminContext = (x: unknown): x is TrustedAdminContext => x !== null && typeof x === 'object' && minted.has(x);

export type AdminSessionDenial =
  | 'ANONYMOUS' | 'MALFORMED_CREDENTIAL' | 'SESSION_EXPIRED' | 'INVALID_TOKEN' | 'IMPERSONATED_SESSION' | 'SESSION_BINDING_MISSING' | 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_NOT_ACTIVE'
  | 'NOT_PLATFORM_ADMIN' | 'SESSION_REVOKED' | 'VERIFICATION_UNAVAILABLE';
export type AdminSessionResult = Readonly<{ ok: true; context: TrustedAdminContext }> | Readonly<{ ok: false; reason: AdminSessionDenial }>;

export interface AdminSessionDeps {
  readonly accessSecret: string;
  readonly users: { findById(id: string): Promise<{ id: string; status: string; platformRole: string | null; isDeleted?: boolean; deletedAt?: Date | null } | undefined> };
  /** DEV-11-R1: is exactly THIS session (this user, this session id) live in persisted state? The refresh-token repository's `isSessionLive`. */
  readonly sessions: { isSessionLive(userId: string, sessionId: string, nowMs: number): Promise<boolean> };
  readonly clock: () => number;
}

/** `authorization` is the raw `Authorization` header value. Nothing else about the request is consulted: a body field, a query parameter or a header such as X-Admin-Id has no effect. */
export async function authenticateAdminSession(deps: AdminSessionDeps, authorization: string | null | undefined): Promise<AdminSessionResult> {
  const deny = (reason: AdminSessionDenial): AdminSessionResult => ({ ok: false, reason });
  try {
    if (!deps || typeof deps.accessSecret !== 'string' || deps.accessSecret.length < 16 || typeof deps.clock !== 'function') return deny('VERIFICATION_UNAVAILABLE');
    if (authorization === null || authorization === undefined || authorization === '') return deny('ANONYMOUS');
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return deny('MALFORMED_CREDENTIAL');
    const token = authorization.slice('Bearer '.length);
    if (token.length === 0 || token.length > 4096 || /\s/.test(token)) return deny('MALFORMED_CREDENTIAL');
    let payload;
    try { payload = await verifyAccessToken(token, deps.accessSecret); }
    catch (e) { return deny((e as { name?: string })?.name === 'JwtTokenExpired' ? 'SESSION_EXPIRED' : 'INVALID_TOKEN'); }
    const nowMs = deps.clock();
    if (!Number.isSafeInteger(nowMs) || typeof payload.exp !== 'number' || payload.exp * 1000 <= nowMs) return deny('SESSION_EXPIRED');
    if (payload.impersonatedBy !== undefined) return deny('IMPERSONATED_SESSION'); // impersonation is a tenant-support tool, never administrative authority
    if (typeof payload.sub !== 'string' || !UUID.test(payload.sub)) return deny('INVALID_TOKEN');
    // LEGACY POLICY: a token without a signed session binding never carries administrative authority (it would be session-independent). The claim is trusted only because the token signature covers it.
    if (payload.sid === undefined) return deny('SESSION_BINDING_MISSING');
    if (typeof payload.sid !== 'string' || !SESSION_ID_PATTERN.test(payload.sid)) return deny('INVALID_TOKEN');
    const user = await deps.users.findById(payload.sub); // authoritative persisted record; the token's claims prove only who the session was issued to
    if (!user || user.id !== payload.sub) return deny('ACCOUNT_NOT_FOUND');
    if (user.isDeleted === true || (user.deletedAt !== undefined && user.deletedAt !== null) || user.status !== 'active') return deny('ACCOUNT_NOT_ACTIVE');
    if (user.platformRole !== 'admin') return deny('NOT_PLATFORM_ADMIN');
    // EXACT-session liveness: this user's row for THIS session id must be unrevoked and unexpired. Another live session of the same user, or any session of another user, cannot satisfy it.
    if (!(await deps.sessions.isSessionLive(user.id, payload.sid, nowMs))) return deny('SESSION_REVOKED');
    const context = Object.freeze({
      adminUserId: user.id, sessionId: (await sha256Hex(`admin-session|${user.id}|${payload.sid}`)).slice(0, 32), verifiedAtMs: nowMs, scope: ADMIN_SCOPE,
      assurance: Object.freeze({ method: 'ACCESS_TOKEN_HS256' as const, impersonated: false as const, liveSession: true as const }), origin: 'SERVER_SESSION' as const,
    }) as unknown as TrustedAdminContext;
    minted.add(context);
    bindings.set(context, Object.freeze({ userId: user.id, sessionId: payload.sid, tokenExpMs: payload.exp * 1000 }));
    return { ok: true, context };
  } catch { return deny('VERIFICATION_UNAVAILABLE'); }
}

export class AdminAuthorityError extends Error {
  constructor(readonly code: 'NOT_A_TRUSTED_CONTEXT' | 'CONTEXT_STALE' | 'CONTEXT_SCOPE' | 'SESSION_NOT_LIVE') { super(`ADMIN_AUTHORITY_${code}`); this.name = 'AdminAuthorityError'; }
}
/** Returns the administrator id carried by a genuine, fresh context, and nothing else can supply one. */
export function requireFreshAdmin(ctx: unknown, nowMs: number, maxAgeMs: number): string {
  if (!isTrustedAdminContext(ctx)) throw new AdminAuthorityError('NOT_A_TRUSTED_CONTEXT');
  if (ctx.scope !== ADMIN_SCOPE) throw new AdminAuthorityError('CONTEXT_SCOPE');
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || ctx.verifiedAtMs > nowMs || nowMs - ctx.verifiedAtMs > maxAgeMs) throw new AdminAuthorityError('CONTEXT_STALE');
  return ctx.adminUserId;
}

export type SessionRevalidation = 'LIVE' | 'NOT_A_TRUSTED_CONTEXT' | 'TOKEN_EXPIRED' | 'SESSION_REVOKED' | 'ACCOUNT_NOT_ACTIVE' | 'NOT_PLATFORM_ADMIN' | 'VERIFICATION_UNAVAILABLE';
export type SessionRevalidator = (ctx: unknown) => Promise<SessionRevalidation>;

/**
 * Re-verifies a context against persisted state at the moment of USE: the token has not expired, the exact session is still live, and the administrator is still active with the admin role. A context is
 * therefore a point-in-time proof only; privileged services call this before every operation, so revoking the session (logout, refresh-token revocation, revoke-all) stops the very next call, not the next
 * authentication. Any failure denies.
 */
export function createSessionRevalidator(deps: Pick<AdminSessionDeps, 'users' | 'sessions' | 'clock'>): SessionRevalidator {
  return async (ctx: unknown): Promise<SessionRevalidation> => {
    try {
      if (!isTrustedAdminContext(ctx)) return 'NOT_A_TRUSTED_CONTEXT';
      const b = bindings.get(ctx);
      if (!b) return 'NOT_A_TRUSTED_CONTEXT';
      const nowMs = deps.clock();
      if (!Number.isSafeInteger(nowMs)) return 'VERIFICATION_UNAVAILABLE';
      if (b.tokenExpMs <= nowMs) return 'TOKEN_EXPIRED';
      const user = await deps.users.findById(b.userId);
      if (!user || user.id !== b.userId || user.isDeleted === true || (user.deletedAt !== undefined && user.deletedAt !== null) || user.status !== 'active') return 'ACCOUNT_NOT_ACTIVE';
      if (user.platformRole !== 'admin') return 'NOT_PLATFORM_ADMIN';
      return (await deps.sessions.isSessionLive(b.userId, b.sessionId, nowMs)) ? 'LIVE' : 'SESSION_REVOKED';
    } catch { return 'VERIFICATION_UNAVAILABLE'; }
  };
}
