import { describe, expect, it } from 'vitest';
import { isQrExpired, msUntilRotation, QR_ROTATE_BEFORE_EXPIRY_MS } from './customer-qr-rotation';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-16T00:00:00.000Z');

describe('customer QR rotation timing', () => {
  it('schedules renewal one hour before a 24h expiry', () => {
    const expiresAt = new Date(NOW + 24 * HOUR).toISOString();
    expect(msUntilRotation(expiresAt, NOW)).toBe(24 * HOUR - QR_ROTATE_BEFORE_EXPIRY_MS);
  });
  it('renews immediately inside the renewal window, after expiry and for an unparseable expiry', () => {
    expect(msUntilRotation(new Date(NOW + 30 * 60 * 1000).toISOString(), NOW)).toBe(0);
    expect(msUntilRotation(new Date(NOW - 1000).toISOString(), NOW)).toBe(0);
    expect(msUntilRotation('not-a-date', NOW)).toBe(0);
  });
  it('reports expiry only at or after the expiry instant', () => {
    expect(isQrExpired(new Date(NOW + 1).toISOString(), NOW)).toBe(false);
    expect(isQrExpired(new Date(NOW).toISOString(), NOW)).toBe(true);
    expect(isQrExpired('garbage', NOW)).toBe(true);
  });
});
