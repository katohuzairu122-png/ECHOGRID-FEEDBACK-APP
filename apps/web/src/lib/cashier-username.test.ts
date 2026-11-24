import { describe, expect, it } from 'vitest';
import { suggestCashierUsername } from './cashier-username';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/; // the API's rule (apps/api/src/cashier-accounts/credentials.ts)

describe('suggestCashierUsername', () => {
  it.each([
    ['Amina Okoye', 'amina.okoye'],
    ["Amína O'Neil", 'amina.o.neil'],
    ['  TILL   9 ', 'till.9'],
    ['Zoë', 'zoe'],
    ['Jo', 'jo.cashier'],
    ['', 'cashier'],
    ['!!!', 'cashier'],
    ['محمد', 'cashier'],
  ])('%j becomes %j', (name, expected) => {
    expect(suggestCashierUsername(name)).toBe(expected);
  });

  it('adds a suffix without breaking the length or character rules', () => {
    expect(suggestCashierUsername('Amina Okoye', '47')).toBe('amina.okoye47');
    const long = suggestCashierUsername('a'.repeat(60), '123');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith('123')).toBe(true);
  });

  it('always satisfies the API username pattern, for awkward inputs too', () => {
    for (const name of ['x', 'Ab', '...', '-_-', 'A'.repeat(100), 'Maria José Ñandú', '1', '  ', 'a.b.c.d.e']) {
      for (const suffix of ['', '7', '482']) {
        expect(suggestCashierUsername(name, suffix)).toMatch(USERNAME_PATTERN);
      }
    }
  });
});
