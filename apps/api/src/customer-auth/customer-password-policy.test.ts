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
