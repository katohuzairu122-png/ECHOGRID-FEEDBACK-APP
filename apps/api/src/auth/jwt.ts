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

export async function signRefreshToken(
  userId: string,
  tokenId: string,
  secret: string,
): Promise<{ token: string; expiresAt: Date }> {
  const iat = now();
  const exp = iat + REFRESH_TOKEN_TTL_SECONDS;
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
export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as AccessTokenPayload;
  if (payload.type !== 'access') throw new Error('Not an access token');
  // a session claim, when present, must be a well-formed random session id: a malformed one is a forged or corrupt token, not an absent binding
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
