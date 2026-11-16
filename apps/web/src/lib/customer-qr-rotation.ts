/**
 * CUSTOMER-QR-ROTATION-01 -- client-side rotation timing for the customer identity QR.
 * The QR is valid for up to 24 hours; the screen renews it well before expiry so the customer never sees an
 * expired code while the page is open. Pure functions: scheduling only, no authority.
 */
export const QR_ROTATE_BEFORE_EXPIRY_MS = 60 * 60 * 1000;
export const QR_ROTATE_RETRY_MS = 30 * 1000;

/** Milliseconds until the QR should be renewed (0 = renew now). An unparseable expiry means renew now. */
export function msUntilRotation(expiresAt: string, now: number, rotateBeforeMs = QR_ROTATE_BEFORE_EXPIRY_MS): number {
  const expires = new Date(expiresAt).getTime();
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, expires - rotateBeforeMs - now);
}

export function isQrExpired(expiresAt: string, now: number): boolean {
  const expires = new Date(expiresAt).getTime();
  return !Number.isFinite(expires) || expires <= now;
}
