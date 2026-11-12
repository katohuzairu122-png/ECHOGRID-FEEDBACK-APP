/**
 * CUSTOMER-AUTH-01D-4a: pure password rules. No I/O.
 *
 * Follows the NIST SP 800-63B direction proposed in 01A section 6.2: a minimum
 * length, a generous maximum, NO forced composition rules and NO periodic
 * rotation, plus rejection of obviously weak values.
 *
 * `minLength` is REQUIRED input, not a default: the minimum length is owner
 * decision CA-05 and this module must not invent it.
 *
 * NOT implemented, on purpose: a breached-password lookup. It needs an
 * outbound network host and a privacy decision (01A section 10), so it is left
 * as an explicit gap rather than a silent one.
 */

export const PASSWORD_MAX_LENGTH_DEFAULT = 128;

export type PasswordPolicyViolation =
  | 'not_a_string'
  | 'too_short'
  | 'too_long'
  | 'control_characters'
  | 'contains_phone'
  | 'too_common'
  | 'repetitive';

export type PasswordPolicyResult =
  { ok: true } | { ok: false; violations: PasswordPolicyViolation[] };

export type PasswordPolicyConfig = {
  minLength: number;
  maxLength?: number;
};

// A short list of the most common passwords that a length rule alone would let
// through. A starter set, not a substitute for a breached-password check.
const COMMON = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'password1234',
  'passw0rd',
  'p@ssw0rd',
  'p@ssword',
  'qwerty',
  'qwerty123',
  'qwertyuiop',
  'qwertyuiop123',
  'asdfghjkl',
  'zxcvbnm',
  '1q2w3e4r',
  '1qaz2wsx',
  '123456',
  '1234567',
  '12345678',
  '123456789',
  '1234567890',
  '0123456789',
  '11111111',
  '00000000',
  'letmein',
  'letmein123',
  'welcome',
  'welcome1',
  'welcome123',
  'iloveyou',
  'iloveyou1',
  'admin123',
  'administrator',
  'abc12345',
  'abcd1234',
  'monkey123',
  'dragon123',
  'football1',
  'baseball1',
  'sunshine1',
  'princess1',
  'superman1',
  'trustno1',
  'changeme',
  'changeme123',
  'echogrid',
  'echogrid123',
  'loyalty123',
]);

// C0 controls (including tab, CR, LF) and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** NFKC, so visually identical passwords hash identically across keyboards and devices (NIST 800-63B). */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC');
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function allSame(value: string): boolean {
  const chars = Array.from(value);
  return chars.length > 0 && chars.every((c) => c === chars[0]);
}

function isRun(value: string): boolean {
  const points = Array.from(value).map((c) => c.codePointAt(0)!);
  if (points.length < 4) return false;
  const step = points[1]! - points[0]!;
  if (Math.abs(step) !== 1) return false;
  return points.every((p, i) => i === 0 || p - points[i - 1]! === step);
}

export function checkPasswordPolicy(
  password: unknown,
  context: { phone: string },
  config: PasswordPolicyConfig,
): PasswordPolicyResult {
  if (!Number.isInteger(config.minLength) || config.minLength <= 0) {
    throw new Error('minLength must be a positive integer.');
  }
  const maxLength = config.maxLength ?? PASSWORD_MAX_LENGTH_DEFAULT;
  if (typeof password !== 'string') return { ok: false, violations: ['not_a_string'] };

  const normalized = normalizePassword(password);
  const length = codePointLength(normalized);
  const violations: PasswordPolicyViolation[] = [];

  if (length < config.minLength) violations.push('too_short');
  if (length > maxLength) violations.push('too_long');
  if (CONTROL.test(normalized)) violations.push('control_characters');

  const phoneDigits = context.phone.replace(/\D/g, '');
  const passwordDigits = normalized.replace(/\D/g, '');
  if (phoneDigits.length >= 7 && passwordDigits.includes(phoneDigits.slice(-7)))
    violations.push('contains_phone');

  if (COMMON.has(normalized.toLowerCase())) violations.push('too_common');
  if (allSame(normalized) || isRun(normalized.toLowerCase())) violations.push('repetitive');

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/** True when an input is small enough to be worth hashing at all. Guards the hash cost against huge bodies. */
export function isHashableLength(
  password: string,
  maxLength = PASSWORD_MAX_LENGTH_DEFAULT,
): boolean {
  // UTF-16 length is an upper bound on code points, so this check never needs a full scan of a huge string.
  return password.length <= maxLength * 2 && codePointLength(password) <= maxLength;
}
