import { sign, verify } from 'hono/jwt';

/**
 * Customer sessions are deliberately simpler than staff's access+refresh+
 * rotation system (auth/jwt.ts): a single long-lived, non-rotating token.
 * Justified by the much lower stakes -- a customer token only ever grants
 * "view/redeem my own points at businesses I'm a member of", with no
 * privilege-escalation surface and nothing equivalent to a staff seat to
 * revoke. A stolen customer token is a much smaller blast radius than a
 * stolen staff access token, so the added complexity of rotation/refresh
 * isn't worth it here. Signed with CUSTOMER_JWT_SECRET, never
 * JWT_ACCESS_SECRET -- a fully separate secret so a leak of one token system
 * never compromises the other.
 */
export interface CustomerAccessTokenPayload {
  sub: string; // customers.id
  type: 'customer_access';
  iat: number;
  exp: number;
}

export const CUSTOMER_ACCESS_TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signCustomerAccessToken(customerId: string, secret: string): Promise<string> {
  const payload: CustomerAccessTokenPayload = {
    sub: customerId,
    type: 'customer_access',
    iat: now(),
    exp: now() + CUSTOMER_ACCESS_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

/** `type` check is defense in depth on top of the separate secret, in case
 * of a future secret-management mistake (e.g. secrets accidentally aliased). */
export async function verifyCustomerAccessToken(
  token: string,
  secret: string,
): Promise<CustomerAccessTokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as CustomerAccessTokenPayload;
  if (payload.type !== 'customer_access') throw new Error('Not a customer access token');
  return payload;
}
