import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: vi.fn(async () => ({ id: 'biz-1' })) }));

import { ApiError } from '@/lib/api-error';
import { reversePurchaseAction } from './loyalty-purchases';

const ID = '6f0f1c5e-0000-4000-8000-000000000004';
const form = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const ok = { purchaseEventId: ID, pointsReversed: 10, pointsShortfall: 0, revokedRewards: 0, rewardsAlreadyUsed: 0, rewardImpact: [], needsReview: false };

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.revalidatePath.mockReset();
});

describe('reversePurchaseAction (LPC-10)', () => {
  it('requires a reason and an explicit confirmation before any request is made', async () => {
    expect(await reversePurchaseAction({}, form({ purchaseId: ID, reason: 'ab', confirm: 'yes' }))).toEqual({ errorCode: 'REASON_REQUIRED' });
    expect(await reversePurchaseAction({}, form({ purchaseId: ID, reason: 'x'.repeat(201), confirm: 'yes' }))).toEqual({ errorCode: 'REASON_REQUIRED' });
    expect(await reversePurchaseAction({}, form({ purchaseId: ID, reason: 'Refunded at the counter' }))).toEqual({ errorCode: 'CONFIRM_REQUIRED' });
    expect(await reversePurchaseAction({}, form({ purchaseId: '../x', reason: 'Refunded', confirm: 'yes' }))).toEqual({ errorCode: 'NOT_FOUND' });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('sends the trimmed reason to the reversal endpoint of that purchase only, and returns the result', async () => {
    mocks.apiFetch.mockResolvedValue(ok);
    const state = await reversePurchaseAction({}, form({ purchaseId: ID, reason: '  Refunded at the counter  ', confirm: 'yes' }));
    expect(state.result).toEqual(ok);
    expect(mocks.apiFetch).toHaveBeenCalledExactlyOnceWith(`/loyalty/purchases/${ID}/reverse`, { method: 'POST', businessId: 'biz-1', body: JSON.stringify({ reason: 'Refunded at the counter' }) });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/loyalty/purchases');
  });

  it('maps the API refusals to stable codes (duplicate, not found, not allowed, cannot reproduce, failure) and never shows server text', async () => {
    const cases: [ApiError, string][] = [
      [new ApiError('x', 409, 'PURCHASE_ALREADY_REVERSED'), 'ALREADY_REVERSED'],
      [new ApiError('x', 404, 'PURCHASE_NOT_FOUND'), 'NOT_FOUND'],
      [new ApiError('x', 403, 'FORBIDDEN'), 'NOT_ALLOWED'],
      [new ApiError('x', 409, 'PROGRESS_REPLAY_MISMATCH'), 'CANNOT_REPRODUCE'],
      [new ApiError('secret detail', 500, 'BOOM'), 'FAILED'],
    ];
    for (const [error, code] of cases) {
      mocks.apiFetch.mockRejectedValueOnce(error);
      expect(await reversePurchaseAction({}, form({ purchaseId: ID, reason: 'Refunded', confirm: 'yes' }))).toEqual({ errorCode: code });
    }
  });
});
