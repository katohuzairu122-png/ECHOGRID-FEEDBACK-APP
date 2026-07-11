import { pbkdf2Hash, pbkdf2Verify } from '../auth/password';

/**
 * OTP-specific constants and primitives, kept separate from
 * customer-auth.service.ts's orchestration logic so the "what is a valid
 * code" rules are testable in isolation.
 *
 * Iteration count is deliberately far below the password constant (600k):
 * OTP security comes from a 10-minute expiry + a 5-attempt cap, not
 * offline-hash resistance, so paying the full password-grade cost on every
 * SMS code check would only add latency, not real protection.
 */
export const OTP_ITERATIONS = 10_000;
export const OTP_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_REQUEST_COOLDOWN_SECONDS = 60;

/** Cryptographically random 6-digit code, zero-padded (never generated via
 * Math.random -- predictable OTPs defeat the entire verification purpose). */
export function generateOtpCode(): string {
  const max = 10 ** OTP_LENGTH;
  const randomValue = crypto.getRandomValues(new Uint32Array(1))[0] % max;
  return randomValue.toString().padStart(OTP_LENGTH, '0');
}

export function hashOtpCode(code: string): Promise<string> {
  return pbkdf2Hash(code, OTP_ITERATIONS);
}

export function verifyOtpCode(code: string, storedHash: string): Promise<boolean> {
  return pbkdf2Verify(code, storedHash);
}

export function otpExpiresAt(): Date {
  return new Date(Date.now() + OTP_EXPIRY_MINUTES * 60_000);
}
