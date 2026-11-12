import { sign, verify } from 'hono/jwt';

/**
 * Short-lived handle issued by a cashier phone lookup (D-C2). It is signed with the QR token secret but carries
 * its own `type`, so it is never accepted as a customer QR token and a customer QR token is never accepted as a
 * lookup token. It binds the lookup to one business, one staff user and one customer, so it cannot be used by
 * another cashier or in another business. The cashier never sees the customer id or the loyalty account id.
 */
export const CUSTOMER_LOOKUP_TOKEN_TYPE = 'staff_customer_lookup';
export const CUSTOMER_LOOKUP_TOKEN_TTL_SECONDS = 2 * 60;

export type CustomerLookupTokenPayload = {
  type: typeof CUSTOMER_LOOKUP_TOKEN_TYPE;
  /** customer id */
  sub: string;
  /** business id */
  bid: string;
  /** staff user id */
  uid: string;
  nonce: string;
  iat: number;
  exp: number;
};

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signCustomerLookupToken(
  input: { customerId: string; businessId: string; staffUserId: string },
  secret: string,
): Promise<string> {
  const iat = now();
  const payload: CustomerLookupTokenPayload = {
    type: CUSTOMER_LOOKUP_TOKEN_TYPE,
    sub: input.customerId,
    bid: input.businessId,
    uid: input.staffUserId,
    nonce: crypto.randomUUID(),
    iat,
    exp: iat + CUSTOMER_LOOKUP_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

function validClaims(payload: unknown): payload is CustomerLookupTokenPayload {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.type === CUSTOMER_LOOKUP_TOKEN_TYPE &&
    typeof p.sub === 'string' &&
    typeof p.bid === 'string' &&
    typeof p.uid === 'string' &&
    typeof p.nonce === 'string' &&
    typeof p.iat === 'number' &&
    typeof p.exp === 'number'
  );
}

async function verifyWithSecret(token: string, secret: string): Promise<CustomerLookupTokenPayload> {
  const payload: unknown = await verify(token, secret, 'HS256');
  if (!validClaims(payload)) throw new Error('Invalid customer lookup token claims');
  return payload;
}

export async function verifyCustomerLookupToken(
  token: string,
  secret: string,
  previousSecret?: string,
): Promise<CustomerLookupTokenPayload> {
  try {
    return await verifyWithSecret(token, secret);
  } catch (err) {
    if (!previousSecret) throw err;
    return verifyWithSecret(token, previousSecret);
  }
}
