import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), revalidatePath: vi.fn(), redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: vi.fn(async () => ({ id: 'biz-1', defaultCurrency: 'KWD' })) }));

import { ApiError } from '@/lib/api-error';
import { programmeAction } from './loyalty-programmes';

const form = (entries: [string, string][]): FormData => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};
const lp03 = (extra: [string, string][] = []) => form([['type', 'LP-03'], ['pointsPerCurrencyUnit', '10'], ['pointsPerCheckin', '0'], ...extra]);

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.revalidatePath.mockReset();
  mocks.redirect.mockReset();
});

describe('programmeAction', () => {
  it('previews with the shared rules and never calls the API', async () => {
    const state = await programmeAction({}, lp03([['intent', 'preview']]));
    expect(state.preview).toMatchObject({ kind: 'table', rows: [{ points: 50 }, { points: 200 }, { points: 1000 }] });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
  it('refuses an invalid configuration with field issues and does not call the API', async () => {
    const state = await programmeAction({}, form([['type', 'LP-03'], ['intent', 'draft'], ['pointsPerCurrencyUnit', '1.23456'], ['pointsPerCheckin', '0']]));
    expect(state).toMatchObject({ errorCode: 'INVALID', issues: [{ path: 'pointsPerCurrencyUnit' }] });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
  it('never offers an unavailable programme', async () => {
    expect(await programmeAction({}, form([['type', 'LP-08'], ['intent', 'draft']]))).toEqual({ errorCode: 'UNAVAILABLE' });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
  it('saves a draft through the API', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ id: 'p-new' });
    const state = await programmeAction({}, lp03([['intent', 'draft']]));
    expect(state).toEqual({ saved: 'draft', programmeId: 'p-new' });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/loyalty/programmes', expect.objectContaining({ method: 'POST', businessId: 'biz-1' }));
  });
  it('saving over an existing programme creates a new configuration version', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ id: 'p1' });
    await programmeAction({}, lp03([['intent', 'draft'], ['programmeId', 'p1']]));
    expect(mocks.apiFetch).toHaveBeenCalledWith('/loyalty/programmes/p1/config', expect.objectContaining({ method: 'PUT' }));
  });
  it('activation requires the confirmation field and does not activate without it', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ id: 'p-new' });
    const state = await programmeAction({}, lp03([['intent', 'activate']]));
    expect(state).toMatchObject({ errorCode: 'CONFIRM_REQUIRED', programmeId: 'p-new' });
    expect(mocks.apiFetch.mock.calls.map((c) => c[0])).toEqual(['/loyalty/programmes']); // saved the draft, never validated or activated
  });
  it('confirmed activation saves, validates, then activates in that order', async () => {
    mocks.apiFetch.mockResolvedValue({ id: 'p-new' });
    const state = await programmeAction({}, lp03([['intent', 'activate'], ['confirm', 'yes']]));
    expect(state).toEqual({ saved: 'activated', programmeId: 'p-new' });
    expect(mocks.apiFetch.mock.calls.map((c) => c[0])).toEqual(['/loyalty/programmes', '/loyalty/programmes/p-new/validate', '/loyalty/programmes/p-new/activate']);
    expect(mocks.apiFetch.mock.calls[2]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ confirm: true }) });
  });
  it('maps an Owner-only refusal to a stable code, never raw server text', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ id: 'p-new' }).mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError('Only the business Owner can activate or switch the loyalty programme.', 403, 'PROGRAM_OWNER_REQUIRED'));
    expect(await programmeAction({}, lp03([['intent', 'activate'], ['confirm', 'yes']]))).toEqual({ errorCode: 'OWNER_REQUIRED' });
  });
  it('pause, retire and activate-existing need confirmation and call the matching endpoint', async () => {
    expect(await programmeAction({}, form([['intent', 'pause'], ['programmeId', 'p1']]))).toEqual({ errorCode: 'CONFIRM_REQUIRED' });
    mocks.apiFetch.mockResolvedValue({});
    expect(await programmeAction({}, form([['intent', 'pause'], ['programmeId', 'p1'], ['confirm', 'yes']]))).toMatchObject({ saved: 'paused' });
    expect(await programmeAction({}, form([['intent', 'retire'], ['programmeId', 'p2'], ['confirm', 'yes']]))).toMatchObject({ saved: 'retired' });
    expect(await programmeAction({}, form([['intent', 'activate-existing'], ['programmeId', 'p3'], ['confirm', 'yes']]))).toMatchObject({ saved: 'activated' });
    expect(mocks.apiFetch.mock.calls.map((c) => c[0])).toEqual(['/loyalty/programmes/p1/deactivate', '/loyalty/programmes/p2/retire', '/loyalty/programmes/p3/activate']);
  });
  it('an unexpected failure becomes a generic code', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('boom'));
    expect(await programmeAction({}, lp03([['intent', 'draft']]))).toEqual({ errorCode: 'FAILED' });
  });
});
