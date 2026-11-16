import { describe, it, expect } from 'vitest';
import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_ENTROPY_BITS,
  RECOVERY_CODE_LENGTH,
  RECOVERY_CODE_NEVER_MATCHES,
  recoveryCodeVerifier,
} from './customer-recovery-code';

const SECRET = 'recovery-code-test-secret-with-at-least-32-bytes';
const A = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const B = '8a1e2d3c-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

describe('recovery code generation', () => {
  it('carries at least 128 bits and the documented format', () => {
    expect(RECOVERY_CODE_ENTROPY_BITS).toBeGreaterThanOrEqual(128);
    const code = generateRecoveryCode();
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){6}[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(code.replace(/-/g, '')).toHaveLength(RECOVERY_CODE_LENGTH);
  });
  it('is unique across many draws (no sequence or reuse)', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateRecoveryCode()));
    expect(seen.size).toBe(2000);
  });
  it('uses the whole alphabet without an obvious bias', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i += 1) for (const c of generateRecoveryCode().replace(/-/g, '')) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(32);
    for (const n of counts.values()) expect(n).toBeGreaterThan(200 * 0.5);
  });
});

describe('recovery code normalization', () => {
  it('accepts case, hyphen, whitespace and the Crockford look-alikes', () => {
    const code = generateRecoveryCode();
    const canonical = normalizeRecoveryCode(code)!;
    expect(canonical).toHaveLength(28);
    expect(normalizeRecoveryCode(code.toLowerCase())).toBe(canonical);
    expect(normalizeRecoveryCode(` ${code.replace(/-/g, ' ')} `)).toBe(canonical);
    expect(normalizeRecoveryCode('O'.repeat(28))).toBe('0'.repeat(28));
    expect(normalizeRecoveryCode('I'.repeat(14) + 'L'.repeat(14))).toBe('1'.repeat(28));
  });
  it.each([undefined, null, 42, {}, '', 'short', 'U'.repeat(28), 'A'.repeat(27), 'A'.repeat(29), 'A'.repeat(65), `${'A'.repeat(27)}!`])(
    'rejects %s',
    (value) => expect(normalizeRecoveryCode(value)).toBeNull(),
  );
});

describe('recovery code verifier', () => {
  const code = generateRecoveryCode();
  it('is a deterministic 64-hex keyed digest that never contains the code', async () => {
    const v = await recoveryCodeVerifier({ secret: SECRET, customerId: A, code });
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(await recoveryCodeVerifier({ secret: SECRET, customerId: A, code })).toBe(v);
    expect(v).not.toBe(RECOVERY_CODE_NEVER_MATCHES);
    expect(v.toUpperCase()).not.toContain(code.replace(/-/g, '').slice(0, 8));
  });
  it('treats equivalent spellings as the same code', async () => {
    expect(await recoveryCodeVerifier({ secret: SECRET, customerId: A, code: code.toLowerCase() }))
      .toBe(await recoveryCodeVerifier({ secret: SECRET, customerId: A, code }));
  });
  it('is bound to the customer, the secret and the code', async () => {
    const base = await recoveryCodeVerifier({ secret: SECRET, customerId: A, code });
    expect(await recoveryCodeVerifier({ secret: SECRET, customerId: B, code })).not.toBe(base);
    expect(await recoveryCodeVerifier({ secret: `${SECRET}-other`, customerId: A, code })).not.toBe(base);
    expect(await recoveryCodeVerifier({ secret: SECRET, customerId: A, code: generateRecoveryCode() })).not.toBe(base);
  });
  it('fails closed on a missing secret, a bad customer id or a non-code', async () => {
    await expect(recoveryCodeVerifier({ secret: 'short', customerId: A, code })).rejects.toThrow();
    await expect(recoveryCodeVerifier({ secret: SECRET, customerId: 'x', code })).rejects.toThrow();
    await expect(recoveryCodeVerifier({ secret: SECRET, customerId: A, code: 'nope' })).rejects.toThrow();
  });
});
