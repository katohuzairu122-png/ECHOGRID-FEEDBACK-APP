import { describe, expect, it } from 'vitest';
import { sign } from 'hono/jwt';
import {
  BUSINESS_CODE_ALPHABET, MIN_PASSWORD_LENGTH, LOCKOUT_DURATION_MS, LOCKOUT_MAX_FAILURES, LOCKOUT_WINDOW_MS,
  REAUTH_PROOF_TTL_SECONDS, generateBusinessCode, isAcceptablePassword, normalizeBusinessCode, normalizeUsername,
  signAdminReauthProof, verifyAdminReauthProof,
} from './credentials';
import { verifyAccessToken } from '../auth/jwt';

const SECRET = 'unit-test-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const BIZ = '22222222-2222-4222-8222-222222222222';

describe('owner-ruled policy constants (D-5)', () => {
  it('match the approved policy', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(LOCKOUT_MAX_FAILURES).toBe(5);
    expect(LOCKOUT_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(LOCKOUT_DURATION_MS).toBe(15 * 60 * 1000);
    expect(REAUTH_PROOF_TTL_SECONDS).toBe(300);
  });
});

describe('business code (D-3)', () => {
  it('generates 10 unambiguous characters, never 0, 1, I or O, and rarely repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = generateBusinessCode();
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
      seen.add(code);
    }
    expect(seen.size).toBe(500);
    expect(BUSINESS_CODE_ALPHABET).toHaveLength(32);
    for (const bad of ['0', '1', 'I', 'O']) expect(BUSINESS_CODE_ALPHABET).not.toContain(bad);
  });
  it('normalises case, spaces and hyphens, and refuses anything that cannot be a code', () => {
    expect(normalizeBusinessCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeBusinessCode(' abcde fghjk ')).toBe('ABCDEFGHJK');
    for (const bad of ['', 'short', 'ABCDEFGHJK1', 'ABCDEFGHIK', 'ABCDEFGHOK', 'ABCDE0GHJK', null, undefined, 42, {}]) {
      expect(normalizeBusinessCode(bad as never), String(bad)).toBeNull();
    }
  });
});

describe('username namespace (D-3)', () => {
  it('canonicalises to lowercase and enforces 3 to 32 allowed characters', () => {
    expect(normalizeUsername('  Cashier01 ')).toBe('cashier01');
    expect(normalizeUsername('a.b_c-d')).toBe('a.b_c-d');
    for (const bad of ['ab', 'a'.repeat(33), '-abc', '.abc', 'a b c', 'abc!', 'ünï', '', null, undefined, 5]) {
      expect(normalizeUsername(bad as never), String(bad)).toBeNull();
    }
    expect(normalizeUsername('a'.repeat(32))).toBe('a'.repeat(32));
  });
  it('two spellings of one name collapse to the same canonical value (no tenant-internal confusion)', () => {
    expect(normalizeUsername('TILL1')).toBe(normalizeUsername('till1'));
  });
});

describe('credentials (D-5)', () => {
  it('accepts 8 to 128 characters only', () => {
    expect(isAcceptablePassword('1234567')).toBe(false);
    expect(isAcceptablePassword('12345678')).toBe(true);
    expect(isAcceptablePassword('x'.repeat(128))).toBe(true);
    expect(isAcceptablePassword('x'.repeat(129))).toBe(false);
    expect(isAcceptablePassword(undefined)).toBe(false);
    expect(isAcceptablePassword(12345678 as never)).toBe(false);
  });
});

describe('administrator re-authentication proof (D-5)', () => {
  it('verifies for the same user and business only', async () => {
    const { proof, expiresAt } = await signAdminReauthProof(USER, BIZ, SECRET);
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(REAUTH_PROOF_TTL_SECONDS * 1000);
    expect(await verifyAdminReauthProof(proof, USER, BIZ, SECRET)).toBe(true);
    expect(await verifyAdminReauthProof(proof, '33333333-3333-4333-8333-333333333333', BIZ, SECRET)).toBe(false);
    expect(await verifyAdminReauthProof(proof, USER, '44444444-4444-4444-8444-444444444444', SECRET)).toBe(false);
    expect(await verifyAdminReauthProof(proof, USER, BIZ, 'another-secret')).toBe(false);
    expect(await verifyAdminReauthProof(undefined, USER, BIZ, SECRET)).toBe(false);
    expect(await verifyAdminReauthProof('garbage', USER, BIZ, SECRET)).toBe(false);
  });
  it('is not an access token, and an access token is not a proof', async () => {
    const { proof } = await signAdminReauthProof(USER, BIZ, SECRET);
    await expect(verifyAccessToken(proof, SECRET)).rejects.toThrow();
    const iat = Math.floor(Date.now() / 1000);
    const access = await sign({ sub: USER, biz: BIZ, type: 'access', iat, exp: iat + 300 }, SECRET, 'HS256');
    expect(await verifyAdminReauthProof(access, USER, BIZ, SECRET)).toBe(false);
  });
  it('expires', async () => {
    const iat = Math.floor(Date.now() / 1000) - 400;
    const old = await sign({ sub: USER, biz: BIZ, type: 'cashier_admin_reauth', iat, exp: iat + 300 }, SECRET, 'HS256');
    expect(await verifyAdminReauthProof(old, USER, BIZ, SECRET)).toBe(false);
  });
});
