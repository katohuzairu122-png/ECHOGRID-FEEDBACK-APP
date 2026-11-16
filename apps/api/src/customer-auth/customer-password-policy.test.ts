import { describe, it, expect } from 'vitest';
import {
  PASSWORD_MAX_LENGTH_DEFAULT,
  checkPasswordPolicy,
  isHashableLength,
  normalizePassword,
} from './customer-password-policy';

const PHONE = '+15551234567';
const CFG = { minLength: 10 };
const check = (p: unknown, phone = PHONE, cfg = CFG) => checkPasswordPolicy(p, { phone }, cfg);

describe('checkPasswordPolicy', () => {
  it('accepts a long passphrase with spaces and no composition rules', () => {
    expect(check('correct horse battery staple')).toEqual({ ok: true });
    expect(check('alllowercaseletters')).toEqual({ ok: true });
  });

  it('requires the configured minimum length, counted in code points', () => {
    expect(check('Abcdefg1x')).toEqual({ ok: false, violations: ['too_short'] });
    expect(check('Abcdefg1xy')).toEqual({ ok: true });
    // 5 emoji are 10 UTF-16 units but only 5 code points.
    expect(check('😀😀😀😀😀')).toMatchObject({
      ok: false,
      violations: expect.arrayContaining(['too_short']),
    });
  });

  it('refuses to invent a minimum: a missing or invalid one throws', () => {
    expect(() => check('whatever password', PHONE, { minLength: 0 })).toThrow();
    expect(() => check('whatever password', PHONE, { minLength: Number.NaN })).toThrow();
    expect(() => check('whatever password', PHONE, {} as never)).toThrow();
  });

  it('caps the length so hashing cost cannot be forced up', () => {
    expect(check('a1'.repeat(PASSWORD_MAX_LENGTH_DEFAULT / 2))).toEqual({ ok: true });
    expect(check('a1'.repeat(PASSWORD_MAX_LENGTH_DEFAULT / 2 + 1))).toEqual({
      ok: false,
      violations: ['too_long'],
    });
    expect(check('a'.repeat(100_000))).toMatchObject({ ok: false });
  });

  it.each([
    ['tab', 'abcdefgh\tijkl'],
    ['newline', 'abcdefgh\nijkl'],
    ['nul', 'abcdefgh\u0000ijkl'],
    ['del', 'abcdefgh\u007fijkl'],
  ])('rejects control characters (%s)', (_n, p) => {
    expect(check(p)).toMatchObject({
      ok: false,
      violations: expect.arrayContaining(['control_characters']),
    });
  });

  it('rejects a password that contains the account phone number', () => {
    expect(check('my number 5551234567 ok')).toMatchObject({
      violations: expect.arrayContaining(['contains_phone']),
    });
    expect(check('zz555-1234-567zz')).toMatchObject({
      violations: expect.arrayContaining(['contains_phone']),
    });
    expect(check('unrelated 9998887777 digits')).toEqual({ ok: true });
  });

  it.each(['password123', 'Password123', 'qwertyuiop', '1234567890', 'iloveyou1', 'ECHOGRID123'])(
    'rejects the common password %s',
    (p) => {
      expect(check(p)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining(['too_common']),
      });
    },
  );

  it.each(['aaaaaaaaaaaa', '1111111111', 'abcdefghij', '9876543210', 'ABCDEFGHIJ'])(
    'rejects the repetitive value %s',
    (p) => {
      expect(check(p)).toMatchObject({
        ok: false,
        violations: expect.arrayContaining(['repetitive']),
      });
    },
  );

  it('reports every violation at once', () => {
    const r = check('aaa');
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.violations).toEqual(expect.arrayContaining(['too_short', 'repetitive']));
  });

  it.each([[undefined], [null], [12345678901], [{}], [['abcdefghijkl']]])(
    'rejects the non-string %j',
    (p) => {
      expect(check(p)).toEqual({ ok: false, violations: ['not_a_string'] });
    },
  );

  it('applies the rules after NFKC normalization', () => {
    expect(check('ｐａｓｓｗｏｒｄ１２３')).toMatchObject({
      violations: expect.arrayContaining(['too_common']),
    });
  });
});

describe('normalizePassword', () => {
  it('maps compatible forms to one value', () => {
    expect(normalizePassword('ＡＢＣ１２３')).toBe('ABC123');
    expect(normalizePassword('é')).toBe('é');
  });
});

describe('isHashableLength', () => {
  it('rejects oversized input cheaply and accepts normal input', () => {
    expect(isHashableLength('x'.repeat(128))).toBe(true);
    expect(isHashableLength('x'.repeat(129))).toBe(false);
    expect(isHashableLength('x'.repeat(5_000_000))).toBe(false);
  });
});

/**
 * CUSTOMER-EMAIL-AUTH-POLICY-01: the owner-approved customer minimum is 8 (CA-05, 2026-11-16). The engine stays
 * configuration-driven; these tests pin what the approved value means at the boundary.
 */
describe('approved customer password policy (minimum 8)', () => {
  const approved = { minLength: 8 };
  const policy = (password: unknown) => checkPasswordPolicy(password, { phone: null }, approved);

  it('rejects seven characters and accepts eight', () => {
    expect(policy('rBq4nZx')).toEqual({ ok: false, violations: ['too_short'] }); // 7
    expect(policy('rBq4nZxk')).toEqual({ ok: true }); // 8
  });
  it('accepts longer passwords up to the unchanged maximum, and still rejects beyond it', () => {
    expect(policy('rBq4nZxk9')).toEqual({ ok: true });
    expect(policy('a long passphrase with spaces, no composition rules, 2026')).toEqual({ ok: true });
    expect(policy('rBq4'.repeat(32))).toEqual({ ok: true }); // 128 = the existing maximum
    expect(policy('rBq4'.repeat(32) + 'x')).toMatchObject({ ok: false, violations: expect.arrayContaining(['too_long']) });
  });
  it('counts code points, not UTF-16 units: eight emoji pass, seven do not', () => {
    expect(policy('🔐🔑🌟🚀🎯🔔🧩🍀')).toEqual({ ok: true });
    expect(policy('🔐🔑🌟🚀🎯🔔🧩')).toMatchObject({ ok: false, violations: expect.arrayContaining(['too_short']) });
  });
  it('lowering the minimum does not relax any other rule', () => {
    expect(policy('password')).toMatchObject({ ok: false, violations: expect.arrayContaining(['too_common']) });
    expect(policy('aaaaaaaa')).toMatchObject({ ok: false, violations: expect.arrayContaining(['repetitive']) });
    expect(policy('12345678')).toMatchObject({ ok: false });
    expect(policy('abcdefgh')).toMatchObject({ ok: false, violations: expect.arrayContaining(['repetitive']) });
    expect(policy('tab\there8')).toMatchObject({ ok: false, violations: expect.arrayContaining(['control_characters']) });
    expect(checkPasswordPolicy('x6690459189', { phone: '+96566904591' }, approved)).toMatchObject({
      ok: false, violations: expect.arrayContaining(['contains_phone']),
    });
  });
  it('is configuration, not a default: no minimum at all still throws, and a higher configured minimum is honoured', () => {
    expect(() => checkPasswordPolicy('rBq4nZxk', { phone: null }, {} as never)).toThrow();
    expect(checkPasswordPolicy('rBq4nZxk', { phone: null }, { minLength: 12 })).toMatchObject({ ok: false });
  });
});
