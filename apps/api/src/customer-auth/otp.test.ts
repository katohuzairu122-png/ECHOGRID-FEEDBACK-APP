import { describe, it, expect } from 'vitest';
import { createDirectPbkdf2Worker } from '../auth/pbkdf2-worker';
import {
  generateOtpCode,
  hashOtpCode,
  verifyOtpCode,
  otpExpiresAt,
  OTP_LENGTH,
  OTP_ITERATIONS,
} from './otp';

const hasher = createDirectPbkdf2Worker();

describe('generateOtpCode', () => {
  it('always produces a zero-padded 6-digit numeric string', () => {
    // Ran many times, not once -- padStart's zero-padding is exactly the
    // kind of thing that only breaks for small random values, so a single
    // lucky draw would not catch a regression here.
    for (let i = 0; i < 200; i++) {
      const code = generateOtpCode();
      expect(code).toHaveLength(OTP_LENGTH);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('is not the same value every call (uses real randomness, not a fixed constant)', () => {
    const codes = new Set(Array.from({ length: 20 }, () => generateOtpCode()));
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe('OTP hashing', () => {
  it('verifies a correct code against its own hash', async () => {
    const hash = await hashOtpCode('123456', hasher);
    await expect(verifyOtpCode('123456', hash, hasher)).resolves.toBe(true);
  });

  it('rejects an incorrect code', async () => {
    const hash = await hashOtpCode('123456', hasher);
    await expect(verifyOtpCode('654321', hash, hasher)).resolves.toBe(false);
  });

  it('uses a far lower iteration count than password hashing -- OTP security comes from expiry + attempt-capping, not offline-hash resistance', async () => {
    const hash = await hashOtpCode('123456', hasher);
    const [, iterations] = hash.split('$');
    expect(Number(iterations)).toBe(OTP_ITERATIONS);
    expect(Number(iterations)).toBeLessThan(600_000);
  });

  it('reuses the same self-describing pbkdf2 hash format password hashing uses', async () => {
    const hash = await hashOtpCode('123456', hasher);
    expect(hash.split('$')[0]).toBe('pbkdf2');
  });
});

describe('otpExpiresAt', () => {
  it('returns a timestamp roughly 10 minutes in the future', () => {
    const expiresAt = otpExpiresAt();
    const minutesOut = (expiresAt.getTime() - Date.now()) / (1000 * 60);
    expect(minutesOut).toBeGreaterThan(9.9);
    expect(minutesOut).toBeLessThan(10.1);
  });
});
