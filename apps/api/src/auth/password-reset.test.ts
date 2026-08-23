import { describe, it, expect } from 'vitest';
import {
  generateResetToken,
  resetTokenExpiresAt,
  buildResetLink,
  PASSWORD_RESET_EXPIRY_MINUTES,
  MIN_PASSWORD_LENGTH,
} from './password-reset';

/**
 * Pure-primitive tests, deliberately separate from auth.service.test.ts's
 * flow tests -- the same split otp.test.ts already uses. These cover the
 * "what is a valid token" rules in isolation, without constructing a
 * service.
 */
describe('generateResetToken', () => {
  it('produces 64 hex characters (256 bits)', () => {
    const token = generateResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat across calls', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateResetToken()));
    expect(tokens.size).toBe(200);
  });
});

describe('resetTokenExpiresAt', () => {
  it('is in the future and within a minute of the documented window', () => {
    const expected = Date.now() + PASSWORD_RESET_EXPIRY_MINUTES * 60_000;
    const actual = resetTokenExpiresAt().getTime();
    expect(actual).toBeGreaterThan(Date.now());
    expect(Math.abs(actual - expected)).toBeLessThan(60_000);
  });

  it('is longer-lived than an SMS OTP, which is typed within seconds', () => {
    expect(PASSWORD_RESET_EXPIRY_MINUTES).toBeGreaterThan(10);
  });
});

describe('buildResetLink', () => {
  it('builds a /reset-password link carrying the token', () => {
    expect(buildResetLink('https://echo-grid.uk', 'abc123')).toBe(
      'https://echo-grid.uk/reset-password?token=abc123',
    );
  });

  it('normalises a trailing slash rather than producing a double slash', () => {
    expect(buildResetLink('https://echo-grid.uk/', 'abc123')).toBe(
      'https://echo-grid.uk/reset-password?token=abc123',
    );
  });

  it('works against a localhost base URL with a port', () => {
    expect(buildResetLink('http://localhost:3000', 'abc123')).toBe(
      'http://localhost:3000/reset-password?token=abc123',
    );
  });

  it('url-encodes the token rather than interpolating it raw', () => {
    // Real tokens are hex, so this can never happen in production -- the
    // assertion pins the encoding behaviour so a future token format change
    // (base64url, say) cannot silently produce a malformed query string.
    expect(buildResetLink('https://echo-grid.uk', 'a b&c')).toBe(
      'https://echo-grid.uk/reset-password?token=a%20b%26c',
    );
  });
});

describe('MIN_PASSWORD_LENGTH', () => {
  it('matches the 12-character minimum signup advertises to users', () => {
    // apps/web's signup form shows "At least 12 characters." A reset flow
    // that accepted less would become the easiest way to get a weak
    // password into the system.
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });
});
