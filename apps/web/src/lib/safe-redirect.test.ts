import { describe, expect, it } from 'vitest';
import { safeInternalPath } from './safe-redirect';

const FB = '/fallback';

describe('safeInternalPath', () => {
  it.each([
    '/loyalty/dashboard',
    '/dashboard',
    '/loyalty/qr-token?autocheckin=1&feedback=received',
    '/a/b?x=1#frag',
    '/',
  ])('accepts %s', (v) => expect(safeInternalPath(v, FB)).toBe(v));

  it.each([
    '//evil.test',
    '//evil.test/phish',
    '/\\evil.test',
    '/\\evil.test/phish',
    '/\\/evil.test',
    '/%5Cevil.test',
    '/%5cevil.test',
    '/%2F/evil.test',
    '/%2f%2fevil.test',
    '/a\\b',
    '/\tevil.test',
    '/\nevil.test',
    '/%09/evil.test',
    '/%0d%0a/evil.test',
    'https://evil.test',
    'http://evil.test',
    'javascript:alert(1)',
    'data:text/html,x',
    'evil.test',
    'loyalty/dashboard',
    ' /dashboard',
    '',
    '/%E0%A4%A',
  ])('rejects %j', (v) => expect(safeInternalPath(v, FB)).toBe(FB));

  it.each([null, undefined, 42, {}, ['/x'], true])('rejects non-string %j', (v) =>
    expect(safeInternalPath(v, FB)).toBe(FB),
  );

  it('rejects very long input', () => {
    expect(safeInternalPath('/' + 'a'.repeat(5000), FB)).toBe(FB);
  });

  it('never resolves off-origin for any accepted value', () => {
    for (const v of ['/x', '/a?b=//c', '/a#//b']) {
      const out = safeInternalPath(v, FB);
      expect(new URL(out, 'https://app.test').origin).toBe('https://app.test');
    }
  });
});
