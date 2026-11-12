import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safe-redirect';

const FALLBACK = '/fallback';

describe('safeInternalPath', () => {
  it.each([
    '/loyalty/dashboard',
    '/',
    '/loyalty/abc?autocheckin=1&feedback=received',
    '/dashboard#section',
    '/loyalty/abc?x=1#frag',
    '/a%20b',
  ])('accepts legitimate path %s unchanged', (value) => {
    expect(safeInternalPath(value, FALLBACK)).toBe(value);
  });

  it.each([
    ['protocol-relative', '//evil.test'],
    ['backslash host', '/\\evil.test/phish'],
    ['slash-backslash', '/\\/evil.test'],
    ['encoded backslash', '/%5Cevil.test'],
    ['encoded backslash lowercase', '/%5cevil.test'],
    ['encoded double slash', '/%2F%2Fevil.test'],
    ['encoded slash + backslash', '/%2F%5Cevil.test'],
    ['absolute https', 'https://evil.test'],
    ['absolute http', 'http://evil.test/x'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,x'],
    ['no leading slash', 'loyalty/dashboard'],
    ['embedded backslash', '/loyalty\\dashboard'],
    ['tab', '/\tevil.test'],
    ['newline', '/\nevil.test'],
    ['carriage return', '/\r/evil.test'],
    ['encoded tab then slash', '/%09/evil.test'],
    ['NUL', '/a\u0000b'],
    ['malformed percent-encoding', '/%E0%A4%A'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(safeInternalPath(value, FALLBACK)).toBe(FALLBACK);
  });

  it.each([[undefined], [null], [42], [{}], [['/a']], [true]])(
    'rejects non-string %j',
    (value) => {
      expect(safeInternalPath(value, FALLBACK)).toBe(FALLBACK);
    },
  );

  it('rejects very long input but accepts one at the limit', () => {
    expect(safeInternalPath('/' + 'a'.repeat(5000), FALLBACK)).toBe(FALLBACK);
    const atLimit = '/' + 'a'.repeat(2047);
    expect(safeInternalPath(atLimit, FALLBACK)).toBe(atLimit);
  });

  it('uses the caller-supplied fallback', () => {
    expect(safeInternalPath('//evil.test', '/loyalty/dashboard')).toBe('/loyalty/dashboard');
  });
});
