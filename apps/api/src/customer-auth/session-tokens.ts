import { decode, sign, verify } from 'hono/jwt';
import { hashToken } from '../auth/token-hash';

/**
 * CUSTOMER-AUTH-01D-1: primitives for the revocable customer session model
 * proposed in CUSTOMER_AUTH_01A section 6.1.
 *
 * Nothing here is wired into any route or middleware, and no customer can
 * obtain one of these tokens yet. The legacy 90-day token in customer-jwt.ts
 * is unchanged and remains the only token the API accepts.
 *
 * Deliberately separate from customer-jwt.ts (legacy) and auth/jwt.ts (staff):
 * a distinct `type`, `iss` and `aud`, and a secret that the caller must supply
 * separately from CUSTOMER_JWT_SECRET, so one token family can never be
 * accepted as another even if a secret is later mixed up.
 */

export const CUSTOMER_SESSION_ACCESS_TOKEN_TYPE = 'customer_session_access';
export const CUSTOMER_SESSION_ISSUER = 'echogrid-customer-session';
export const CUSTOMER_SESSION_AUDIENCE = 'echogrid-customer-api';

/** PROPOSED in 01A (CA-02 is still an owner decision). Callers may override. */
export const CUSTOMER_SESSION_ACCESS_TTL_SECONDS = 15 * 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REFRESH_CREDENTIAL_BYTES = 32;
const REFRESH_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Declared as `type` so it gets an implicit string index signature and is
// assignable to hono/jwt's JWTPayload, same as the other token payloads.
export type CustomerSessionAccessTokenPayload = {
  sub: string; // customers.id
  sid: string; // customer_sessions.id
  type: typeof CUSTOMER_SESSION_ACCESS_TOKEN_TYPE;
  iss: typeof CUSTOMER_SESSION_ISSUER;
  aud: typeof CUSTOMER_SESSION_AUDIENCE;
  iat: number;
  exp: number;
};

export type SignSessionTokenOptions = {
  ttlSeconds?: number;
  /** Test seam. Seconds since the epoch. */
  nowSeconds?: number;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export async function signCustomerSessionAccessToken(
  customerId: string,
  sessionId: string,
  secret: string,
  options: SignSessionTokenOptions = {},
): Promise<string> {
  if (!secret) throw new Error('A customer session signing secret is required.');
  if (!isUuid(customerId)) throw new Error('Invalid customer id.');
  if (!isUuid(sessionId)) throw new Error('Invalid session id.');
  const ttl = options.ttlSeconds ?? CUSTOMER_SESSION_ACCESS_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error('Invalid token lifetime.');

  const iat = options.nowSeconds ?? nowSeconds();
  const payload: CustomerSessionAccessTokenPayload = {
    sub: customerId,
    sid: sessionId,
    type: CUSTOMER_SESSION_ACCESS_TOKEN_TYPE,
    iss: CUSTOMER_SESSION_ISSUER,
    aud: CUSTOMER_SESSION_AUDIENCE,
    iat,
    exp: iat + ttl,
  };
  return sign(payload, secret, 'HS256');
}

/**
 * Verifies signature (HS256 pinned), expiry, issuer, audience, the `type`
 * claim, and the shape of `sub` and `sid`. Throws on any failure. It does NOT
 * check that the session is live or the customer is active: that needs the
 * database and belongs to the middleware (01D-6) using session-policy.ts.
 */
export async function verifyCustomerSessionAccessToken(
  token: string,
  secret: string,
): Promise<CustomerSessionAccessTokenPayload> {
  if (!secret) throw new Error('A customer session signing secret is required.');
  const payload = (await verify(token, secret, {
    alg: 'HS256',
    iss: CUSTOMER_SESSION_ISSUER,
    aud: CUSTOMER_SESSION_AUDIENCE,
  })) as Partial<CustomerSessionAccessTokenPayload>;

  if (payload.type !== CUSTOMER_SESSION_ACCESS_TOKEN_TYPE) {
    throw new Error('Not a customer session access token');
  }
  if (!isUuid(payload.sub) || !isUuid(payload.sid)) {
    throw new Error('Malformed customer session access token claims');
  }
  if (typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
    throw new Error('Malformed customer session access token claims');
  }
  return payload as CustomerSessionAccessTokenPayload;
}

export type BearerTokenKind = 'session' | 'legacy' | 'unknown';

/**
 * ROUTING HINT ONLY. Reads the unverified `type` claim to decide which
 * verifier to try first (new session token versus the legacy 90-day token).
 * It proves nothing: a forged token can claim any type. Acceptance must come
 * from a successful verify call, never from this function.
 */
export function routeBearerToken(token: string): BearerTokenKind {
  try {
    const { payload } = decode(token);
    if (payload.type === CUSTOMER_SESSION_ACCESS_TOKEN_TYPE) return 'session';
    if (payload.type === 'customer_access') return 'legacy';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** 256 bits from the platform CSPRNG, base64url. Never derived from any input. */
export function generateRefreshCredential(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(REFRESH_CREDENTIAL_BYTES)));
}

export function isWellFormedRefreshCredential(value: unknown): value is string {
  return typeof value === 'string' && REFRESH_CREDENTIAL_PATTERN.test(value);
}

/**
 * SHA-256 hex of a refresh credential, for storage and lookup. Plain SHA-256
 * is correct here for the same reason as staff reset tokens: the input is 256
 * random bits, so there is nothing to brute-force. Input shape is checked
 * first so an attacker cannot make the server hash arbitrarily large bodies.
 */
export async function hashRefreshCredential(credential: string): Promise<string> {
  if (!isWellFormedRefreshCredential(credential)) {
    throw new Error('Malformed refresh credential.');
  }
  return hashToken(credential);
}
