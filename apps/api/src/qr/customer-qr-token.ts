import { sign, verify } from 'hono/jwt';
import { validCustomerQrClaims } from './qr-claims-validation';

export type CustomerQrTokenPayload = {
  sub: string;
  type: 'qr_customer';
  sigVer: number;
  nonce: string;
  /** Revocation epoch the token was issued under. Absent on tokens issued before CUSTOMER-QR-ROTATION-01 (= 0). */
  rev?: number;
  iat: number;
  exp: number;
};

export const CUSTOMER_QR_TOKEN_SIGNATURE_VERSION = 1;
/**
 * Customer QR credential lifetime (CUSTOMER-QR-ROTATION-01). The QR is an IDENTITY credential only: it names a
 * customer and authorizes nothing by itself. Every points / redemption / payment action keeps its own staff
 * authorization, idempotency key and replay protection, so a longer identity lifetime does not widen any
 * transaction authority. A successful transaction never invalidates the QR; only expiry or an explicit revoke does.
 */
export const CUSTOMER_QR_TOKEN_TTL_SECONDS = 24 * 60 * 60;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signCustomerQrToken(customerId: string, secret: string, revocationEpoch = 0): Promise<string> {
  const iat = now();
  const payload: CustomerQrTokenPayload = {
    sub: customerId,
    type: 'qr_customer',
    sigVer: CUSTOMER_QR_TOKEN_SIGNATURE_VERSION,
    nonce: crypto.randomUUID(),
    rev: revocationEpoch,
    iat,
    exp: iat + CUSTOMER_QR_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

async function verifyWithSecret(token: string, secret: string): Promise<CustomerQrTokenPayload> {
  const payload: unknown = await verify(token, secret, 'HS256');
  if (!validCustomerQrClaims(payload, CUSTOMER_QR_TOKEN_SIGNATURE_VERSION)) throw new Error('Invalid customer QR token claims');
  return payload as CustomerQrTokenPayload;
}

export async function verifyCustomerQrToken(
  token: string,
  secret: string,
  previousSecret?: string,
): Promise<CustomerQrTokenPayload> {
  try {
    return await verifyWithSecret(token, secret);
  } catch (err) {
    if (!previousSecret) throw err;
    return verifyWithSecret(token, previousSecret);
  }
}

/** True when the token was issued under an older revocation epoch than the customer's current one. */
export function isCustomerQrRevoked(payload: Pick<CustomerQrTokenPayload, 'rev'>, currentEpoch: number): boolean {
  return (payload.rev ?? 0) !== currentEpoch;
}
