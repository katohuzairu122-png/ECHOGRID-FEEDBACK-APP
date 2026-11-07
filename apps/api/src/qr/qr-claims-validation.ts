/**
 * DEV-73 — structural validation after verifying QR JWT signatures.
 *
 * A valid HMAC authenticates the bytes; it does not prove the payload has
 * the business/customer identity claims expected by downstream code.
 * Keep the existing physical business QR legacy type and two-secret
 * rotation behavior; never derive authority from an unverified payload.
 */
const QR_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const isId = (value: unknown): value is string =>
  typeof value === 'string' && QR_IDENTIFIER.test(value);

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function commonClaims(value: Record<string, unknown>, signatureVersion: number): boolean {
  return isId(value.sub) &&
    value.sigVer === signatureVersion &&
    typeof value.nonce === 'string' &&
    value.nonce.length > 0 &&
    value.nonce.length <= 256 &&
    value.nonce.trim() === value.nonce &&
    typeof value.iat === 'number' &&
    Number.isSafeInteger(value.iat) &&
    value.iat > 0 &&
    typeof value.exp === 'number' &&
    Number.isSafeInteger(value.exp) &&
    value.exp > value.iat;
}

export function validBusinessQrClaims(value: unknown, signatureVersion: number): boolean {
  const claims = objectValue(value);
  return claims !== null &&
    (claims.type === 'qr_business' || claims.type === 'qr_feedback') &&
    commonClaims(claims, signatureVersion) &&
    isId(claims.businessId) &&
    isId(claims.branchId) &&
    (claims.campaignId === null || isId(claims.campaignId));
}

export function validCustomerQrClaims(value: unknown, signatureVersion: number): boolean {
  const claims = objectValue(value);
  return claims !== null &&
    claims.type === 'qr_customer' &&
    commonClaims(claims, signatureVersion);
}
