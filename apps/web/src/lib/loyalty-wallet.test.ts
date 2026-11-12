import { describe, expect, it } from 'vitest';
import type { LoyaltyAccountDto } from '@echo-grid-feedback/shared-types';
import { ApiError } from './api-error';
import { classifyWalletFailure, resolveWalletEntries, sortWalletEntries } from './loyalty-wallet';

const acct = (
  over: Partial<LoyaltyAccountDto> & { id: string; businessId: string },
): LoyaltyAccountDto => ({
  customerId: 'c1',
  points: 0,
  tierId: null,
  visitCount: 0,
  lastVisitAt: null,
  status: 'active',
  ...over,
});

describe('resolveWalletEntries', () => {
  it('keeps the wallet when one business name fails to load (neutral fallback for that card only)', async () => {
    const accounts = [acct({ id: 'a1', businessId: 'b1' }), acct({ id: 'a2', businessId: 'b2' })];
    const entries = await resolveWalletEntries(accounts, async (id) => {
      if (id === 'b2') throw new Error('down');
      return 'Cafe One';
    });
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.account.id === 'a1')?.businessName).toBe('Cafe One');
    expect(entries.find((e) => e.account.id === 'a2')?.businessName).toBeNull();
  });
  it('treats a blank name as missing and never throws', async () => {
    const [entry] = await resolveWalletEntries(
      [acct({ id: 'a1', businessId: 'b1' })],
      async () => '  ',
    );
    expect(entry?.businessName).toBeNull();
    expect(await resolveWalletEntries([], async () => 'x')).toEqual([]);
  });
});

describe('sortWalletEntries', () => {
  const e = (id: string, name: string | null, over: Partial<LoyaltyAccountDto> = {}) => ({
    account: acct({ id, businessId: id, ...over }),
    businessName: name,
  });
  it('orders active first, then most recent visit, then name; paused last', () => {
    const sorted = sortWalletEntries([
      e('p', 'Paused', { status: 'suspended', lastVisitAt: '2026-11-10T00:00:00Z' }),
      e('old', 'Old', { lastVisitAt: '2026-01-01T00:00:00Z' }),
      e('new', 'New', { lastVisitAt: '2026-11-01T00:00:00Z' }),
      e('never-b', 'Bravo'),
      e('never-a', 'Alpha'),
    ]);
    expect(sorted.map((x) => x.account.id)).toEqual(['new', 'old', 'never-a', 'never-b', 'p']);
  });
  it('is deterministic and does not use points to order or total anything', () => {
    const input = [e('x', 'Same', { points: 5 }), e('y', 'Same', { points: 500 })];
    expect(sortWalletEntries(input).map((x) => x.account.id)).toEqual(
      sortWalletEntries([...input].reverse()).map((x) => x.account.id),
    );
  });
  it('puts an unnamed business after named ones with equal standing', () => {
    expect(sortWalletEntries([e('u', null), e('n', 'Zed')]).map((x) => x.account.id)).toEqual([
      'n',
      'u',
    ]);
  });
});

describe('classifyWalletFailure', () => {
  it('shows an explicit unavailable state for a rate limit, an outage or a network failure', () => {
    expect(classifyWalletFailure(new ApiError('x', 429))).toBe('unavailable');
    expect(classifyWalletFailure(new ApiError('x', 503))).toBe('unavailable');
    expect(classifyWalletFailure(new Error('network'))).toBe('unavailable');
  });
  it('does not hide a client error or an authorization failure behind that state', () => {
    for (const status of [400, 403, 404, 422])
      expect(classifyWalletFailure(new ApiError('x', status))).toBe('rethrow');
  });
});
