/**
 * SEC-CASHIER-R2 F8. A redemption code is typed by a person and sent to the API inside a URL path. The codes the API
 * issues are 8 upper-case letters and digits, so anything else is refused here, before a request exists: no path
 * separator, dot segment, query or fragment can ride in a code (encodeURIComponent alone leaves "." and ".." intact,
 * and a ".." segment resolves to the parent path). Valid codes pass through unchanged, and are still encoded.
 */
const REDEMPTION_CODE = /^[A-Z0-9]{1,32}$/;

export function normalizeRedemptionCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** The encoded code for a request path, or null when the value is not a well-formed redemption code. */
export function redemptionCodeSegment(raw: string): string | null {
  const code = normalizeRedemptionCode(raw);
  return REDEMPTION_CODE.test(code) ? encodeURIComponent(code) : null;
}
