import { beforeEach, describe, expect, it, vi } from 'vitest';

/** SEC-CASHIER-R2 F8: a redemption code is data, never part of the request path syntax. */
vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ api: vi.fn(), business: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  apiFetch: m.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public code?: string) {
      super(message);
    }
  },
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { confirmRedemptionAction, lookupRedemptionAction } from './loyalty';
import { redemptionCodeSegment } from '@/lib/redemption-code';

const form = (code: string) => {
  const f = new FormData();
  f.set('code', code);
  return f;
};
const pathOf = () => m.api.mock.calls.at(-1)![0] as string;

beforeEach(() => {
  vi.clearAllMocks();
  m.business.mockResolvedValue({ id: 'biz-1' });
  m.api.mockResolvedValue({ redemptionCode: 'X' });
});

describe('redemption code encoding', () => {
  const nasty = ['A/B', '..', '.', '../team', '..%2fteam', 'a?b=c', 'a#b', 'a b', '%2f', '%', 'é\u0000', 'x/../../platform/businesses', '\\..\\', '', '   ', 'A'.repeat(33)];

  it.each(nasty)('lookup of %j is refused before any request exists', async (raw) => {
    const state = await lookupRedemptionAction({}, form(raw));
    expect(state.error).toBeTruthy();
    expect(m.api).not.toHaveBeenCalled();
  });

  it.each(nasty)('confirm of %j is refused before any request exists', async (raw) => {
    await expect(confirmRedemptionAction(raw)).rejects.toThrow('Invalid redemption code.');
    expect(m.api).not.toHaveBeenCalled();
  });

  it('an ordinary code is unchanged, so valid redemptions behave as before', async () => {
    await lookupRedemptionAction({}, form(' abc123x8 '));
    expect(pathOf()).toBe('/loyalty/redemptions/ABC123X8');
    await confirmRedemptionAction('ABC123X8');
    expect(pathOf()).toBe('/loyalty/redemptions/ABC123X8/confirm');
  });

  it('the shared helper encodes and rejects consistently', () => {
    expect(redemptionCodeSegment('abcd2345')).toBe('ABCD2345');
    for (const raw of ['..', 'a/b', 'a%2fb']) expect(redemptionCodeSegment(raw), raw).toBeNull();
  });
});
