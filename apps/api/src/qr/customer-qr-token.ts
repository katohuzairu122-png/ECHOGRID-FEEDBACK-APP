import { sign, verify } from 'hono/jwt';

export type CustomerQrTokenPayload = {
  sub: string;
  type: 'qr_customer';
  sigVer: number;
  nonce: string;
  iat: number;
  exp: number;
};

export const CUSTOMER_QR_TOKEN_SIGNATURE_VERSION = 1;
export const CUSTOMER_QR_TOKEN_TTL_SECONDS = 5 * 60;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export async function signCustomerQrToken(customerId: string, secret: string): Promise<string> {
  const iat = now();
  const payload: CustomerQrTokenPayload = {
    sub: customerId,
    type: 'qr_customer',
    sigVer: CUSTOMER_QR_TOKEN_SIGNATURE_VERSION,
    nonce: crypto.randomUUID(),
    iat,
    exp: iat + CUSTOMER_QR_TOKEN_TTL_SECONDS,
  };
  return sign(payload, secret, 'HS256');
}

async function verifyWithSecret(token: string, secret: string): Promise<CustomerQrTokenPayload> {
  const payload = (await verify(token, secret, 'HS256')) as CustomerQrTokenPayload;
  if (payload.type !== 'qr_customer') throw new Error('Not a customer QR token');
  return payload;
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
