import { sign, verify } from 'hono/jwt';

// Declared as `type` (not `interface`) so each gets an implicit string index
// signature and is assignable to hono/jwt's `JWTPayload` param -- interfaces
// are open to augmentation and TS withholds that implicit index signature.
export type AccessTokenPayload = {
  sub: string; // userId
  type: 'access';
  // Set only on a token minted by signImpersonationToken (Platform Admin
  // Console Block 4): the platform admin's own userId. sub is the
  // IMPERSONATED user -- everything downstream (authenticate,
  // resolveTenantContext, every tenant route) sees exactly the token it
  // would for that user's own real session, so impersonation needs zero
  // special-casing anywhere else. This claim exists purely so authenticate
  // can surface it to auditTrail for accountability -- see middleware/
  // audit.ts.
  impersonatedBy?: string;
  // DEV-11-R1: the persisted SESSION this token belongs to (refresh_tokens.session_id), signed with the token. Absent on legacy tokens and on impersonation tokens; privileged administrative
  // functions refuse a token without it. Never read from a request parameter: it is trusted only because the signature covers it.
  sid?: string;
  // CASHIER-PWA-01 C2: a cashier-scoped token. `client` marks it, `bid` binds it to ONE business and `brid` to ONE
  // branch (absent for a business-wide binding). All three are covered by the signature and are never read from a
  // request parameter. A cashier token is accepted only on the explicit allow-list in middleware/cashier-scope.ts,
  // and never together with impersonation. Ordinary tokens carry none of these claims.
  client?: 'cashier';
  bid?: string;
  brid?: string;
  iat: number;
  exp: number;
};

export type RefreshTokenPayload = {
  sub: string; // userId
  jti: string; // refresh_tokens.id -- links the JWT to its DB record
  type: 'refresh';
  iat: number;
  exp: number;
};

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// Deliberately shorter than a normal access token, and never paired with a
// refresh token (see signImpersonationToken) -- an impersonation session
// that outlives its purpose should require the admin to consciously
// re-initiate (re-validating the target's grant, re-logging the action)
// rather than silently renewing itself for as long as a normal login would.
export const IMPERSONATION_TOKEN_TTL_SECONDS = 30 * 60; // 30 minutes

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export const CASHIER_CLIENT = 'cashier' as const;
/** Cashier sessions are shorter-lived than web sessions: a counter device that is not used for this long signs out. */
export const CASHIER_REFRESH_TOKEN_TTL_SECONDS = 12 * 60 * 60;
/** How long a business-selection ticket (issued after a correct password when the user has several choices) lasts. */
export const CASHIER_SELECTION_TICKET_TTL_SECONDS = 5 * 60;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function signAccessToken(userId: string, secret: string, sessionId?: string): Promise<string> {
  if (sessionId !== undefined && !SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid session id.');
  const payload: AccessTokenPayload = {
    sub: userId,
    type: 'access',
    ...(sessionId !== undefined ? { sid: sessionId } : {}),
    iat: now(),
    exp: now() + ACCESS_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

/**
 * Signs a cashier-scoped access token (CASHIER-PWA-01 C2). Nothing issues one yet: the cashier login flow is a later
 * block, so this exists to fix the contract and to let tests exercise the allow-list. A session id is mandatory and
 * the business must be a well-formed id; the branch is optional.
 */
export async function signCashierAccessToken(
  userId: string,
  secret: string,
  binding: { sessionId: string; businessId: string; branchId?: string | null },
): Promise<string> {
  if (!SESSION_ID_PATTERN.test(binding.sessionId)) throw new Error('Invalid session id.');
  if (!ID_PATTERN.test(binding.businessId)) throw new Error('Invalid business id.');
  if (binding.branchId != null && !ID_PATTERN.test(binding.branchId)) throw new Error('Invalid branch id.');
  const iat = now();
  const payload: AccessTokenPayload = {
    sub: userId,
    type: 'access',
    client: CASHIER_CLIENT,
    bid: binding.businessId,
    ...(binding.branchId != null ? { brid: binding.branchId } : {}),
    sid: binding.sessionId,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

export async function signRefreshToken(
  userId: string,
  tokenId: string,
  secret: string,
  ttlSeconds: number = REFRESH_TOKEN_TTL_SECONDS,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = now();
  const exp = iat + ttlSeconds;
  const payload: RefreshTokenPayload = { sub: userId, jti: tokenId, type: 'refresh', iat, exp };
  const token = await sign(payload, secret, 'HS256');
  return { token, expiresAt: new Date(exp * 1000) };
}

/**
 * Signed with the same JWT_ACCESS_SECRET and type:'access' as a normal
 * login -- verifyAccessToken and every route that calls it (authenticate,
 * resolveTenantContext, requirePermission) need zero changes to accept this
 * token; only the extra impersonatedBy claim distinguishes it. Callers
 * (ImpersonationService) are responsible for validating the target user and
 * their grant at the target business BEFORE calling this -- signing itself
 * does not check anything.
 */
export async function signImpersonationToken(
  targetUserId: string,
  adminUserId: string,
  secret: string,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = now();
  const exp = iat + IMPERSONATION_TOKEN_TTL_SECONDS;
  const payload: AccessTokenPayload = {
    sub: targetUserId,
    type: 'access',
    impersonatedBy: adminUserId,
    iat,
    exp,
  };
  const token = await sign(payload, secret, 'HS256');
  return { token, expiresAt: new Date(exp * 1000) };
}

/**
 * Access and refresh tokens are signed with different secrets, so one can
 * never verify as the other -- the `type` field is defense in depth on top
 * of that, in case of a future secret-management mistake.
 */
/**
 * Cashier-scope claims are all-or-nothing. A token without `client` must not carry a binding (a half-formed or
 * tampered token is refused, not treated as an ordinary one). A token with `client` must be exactly a cashier token:
 * the known client value, a well-formed business binding, an optional well-formed branch, a mandatory session id,
 * and no impersonation.
 */
function assertScopeClaims(payload: AccessTokenPayload): void {
  const p = payload as Record<string, unknown>;
  if (p.client === undefined) {
    if (p.bid !== undefined || p.brid !== undefined) throw new Error('Binding claims without a client.');
    return;
  }
  if (p.client !== CASHIER_CLIENT) throw new Error('Unknown token client.');
  if (typeof p.bid !== 'string' || !ID_PATTERN.test(p.bid)) throw new Error('Invalid business binding.');
  if (p.brid !== undefined && (typeof p.brid !== 'string' || !ID_PATTERN.test(p.brid))) throw new Error('Invalid branch binding.');
  if (typeof p.sid !== 'string') throw new Error('A cashier token needs a session id.');
  if (p.impersonatedBy !== undefined) throw new Error('A cashier token cannot be an impersonation token.');
}

/** Verifies a token and requires it to be a cashier-scoped one: an ordinary access token is refused. */
export async function verifyCashierAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload & { client: 'cashier'; bid: string }> {
  const payload = await verifyAccessToken(token, secret);
  if (payload.client !== CASHIER_CLIENT || payload.bid === undefined) throw new Error('Not a cashier token');
  return payload as AccessTokenPayload & { client: 'cashier'; bid: string };
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as AccessTokenPayload;
  if (payload.type !== 'access') throw new Error('Not an access token');
  // a session claim, when present, must be a well-formed random session id: a malformed one is a forged or corrupt token, not an absent binding
  assertScopeClaims(payload);
  if (payload.sid !== undefined && (typeof payload.sid !== 'string' || !SESSION_ID_PATTERN.test(payload.sid))) throw new Error('Malformed session claim');
  return payload;
}

export async function verifyRefreshToken(
  token: string,
  secret: string,
): Promise<RefreshTokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as RefreshTokenPayload;
  if (payload.type !== 'refresh') throw new Error('Not a refresh token');
  return payload;
}

/**
 * A short-lived proof that THIS user just entered a correct password in the cashier login, used only to finish
 * choosing a business and branch without re-sending the password. Its `type` is not `access`, so it can never verify
 * as an access token, and it is useless anywhere except the cashier session endpoint.
 */
export async function signCashierSelectionTicket(
  userId: string,
  secret: string,
  deviceLabel?: string,
  /** SEC-CASHIER-R2 F7: fingerprint of the credential at sign-in; a password change before use voids the ticket. */
  passwordVersion?: string,
): Promise<string> {
  const iat = now();
  return sign(
    {
      sub: userId,
      type: 'cashier_select',
      // SEC-CASHIER-R2 F7: single-use identity; consumed atomically when the ticket is exchanged for a session.
      jti: crypto.randomUUID(),
      ...(passwordVersion ? { pwv: passwordVersion } : {}),
      ...(deviceLabel ? { dl: deviceLabel } : {}),
      iat,
      exp: iat + CASHIER_SELECTION_TICKET_TTL_SECONDS,
    },
    secret,
    'HS256',
  );
}

export async function verifyCashierSelectionTicket(
  token: string,
  secret: string,
): Promise<{ sub: string; jti: string; pwv: string | null; expiresAt: Date; deviceLabel?: string }> {
  const payload = (await verify(token, secret, 'HS256')) as {
    sub?: unknown;
    type?: unknown;
    dl?: unknown;
    jti?: unknown;
    pwv?: unknown;
    exp?: unknown;
  };
  if (payload.type !== 'cashier_select' || typeof payload.sub !== 'string') throw new Error('Not a selection ticket');
  // A ticket with no jti cannot be made single-use, so it is refused (they live five minutes).
  if (typeof payload.jti !== 'string' || typeof payload.exp !== 'number') throw new Error('Selection ticket has no identity');
  return {
    sub: payload.sub,
    jti: payload.jti,
    pwv: typeof payload.pwv === 'string' ? payload.pwv : null,
    expiresAt: new Date(payload.exp * 1000),
    ...(typeof payload.dl === 'string' ? { deviceLabel: payload.dl } : {}),
  };
}
