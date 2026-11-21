import { beforeEach, describe, expect, it, vi } from 'vitest';
import { leaveCommunityAction } from './community-membership';
import { customerApiFetch } from '@/lib/customer-api-client';
import { ApiError } from '@/lib/api-error';
import { revalidatePath } from 'next/cache';
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const fetcher = vi.mocked(customerApiFetch);
const form = () => { const f = new FormData(); f.set('confirmed', 'yes'); return f; };
const customerId = '11111111-1111-4111-8111-111111111111';
const response = () => ({ membership: { id: '22222222-2222-4222-8222-222222222222', customerId, status: 'left', policyVersion: 'fixture-only', joinedAt: '2026-11-01T00:00:00Z', leftAt: '2026-11-21T00:00:00Z', suspendedAt: null, createdAt: '', updatedAt: '' }, account: { id: '33333333-3333-4333-8333-333333333333', customerId, status: 'closed', pointsBalance: 80, createdAt: '', updatedAt: '' } });
beforeEach(() => vi.resetAllMocks());
describe('Community leave boundary', () => {
  it('requires explicit confirmation before any API request', async () => {
    expect(await leaveCommunityAction({}, new FormData())).toEqual({ error: 'confirmation' });
    const f = form(); f.append('confirmed', 'yes');
    expect(await leaveCommunityAction({}, f)).toEqual({ error: 'confirmation' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(['customerId', 'verified', 'policyVersion', 'join', 'returnTo'])('rejects a client-supplied %s', async (key) => {
    const f = form(); f.set(key, 'forged');
    expect(await leaveCommunityAction({}, f)).toEqual({ error: 'confirmation' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses only the existing authenticated leave route and invalidates authoritative reads', async () => {
    fetcher.mockResolvedValue(response());
    expect(await leaveCommunityAction({}, form())).toEqual({ left: true });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/community/me/leave', { method: 'POST' }, '/loyalty/dashboard/community');
    expect(revalidatePath).toHaveBeenCalledWith('/loyalty/dashboard/community');
  });
  it.each([null, {}, { ...response(), membership: null }, { ...response(), account: { ...response().account, status: 'active' } }, { ...response(), account: { ...response().account, customerId: '44444444-4444-4444-8444-444444444444' } }])('does not claim success for malformed/inconsistent data %j', async (raw) => {
    fetcher.mockResolvedValue(raw);
    expect(await leaveCommunityAction({}, form())).toEqual({ error: 'unavailable' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each([['COMMUNITY_MEMBERSHIP_SUSPENDED', 'suspended'], ['COMMUNITY_MEMBERSHIP_NOT_FOUND', 'missing'], ['OTHER', 'unavailable']])('maps %s without leaking private error text', async (code, error) => {
    fetcher.mockRejectedValue(new ApiError('private detail', 409, code));
    expect(await leaveCommunityAction({}, form())).toEqual({ error });
  });
  it('preserves session redirect control flow', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' });
    fetcher.mockRejectedValue(redirect);
    await expect(leaveCommunityAction({}, form())).rejects.toBe(redirect);
  });
});
