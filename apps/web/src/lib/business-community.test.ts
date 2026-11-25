import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => vi.fn());
vi.mock('./api-client', () => ({ apiFetch: api }));

import { getBusinessCommunityStatus, parseCommunityStatus } from './business-community';

beforeEach(() => vi.clearAllMocks());

describe('Community rollout status (fails closed: an unread state never looks open)', () => {
  it('accepts exactly the three-field shape the API returns', () => {
    expect(parseCommunityStatus({ enrollment: 'open', feed: 'closed', publishing: 'closed' })).toEqual({ state: 'ready', status: { enrollment: 'open', feed: 'closed', publishing: 'closed' } });
  });
  it('anything else is unavailable: null, wrong types, unknown states, and a publishing state other than closed (it is not implemented)', () => {
    for (const bad of [null, undefined, 'open', 7, {}, { enrollment: 'open' }, { enrollment: 'maybe', feed: 'closed', publishing: 'closed' },
      { enrollment: 'open', feed: true, publishing: 'closed' }, { enrollment: 'closed', feed: 'closed', publishing: 'open' }]) {
      expect(parseCommunityStatus(bad), JSON.stringify(bad)).toEqual({ state: 'unavailable' });
    }
  });
  it('reads only the read-only status route for the named business', async () => {
    api.mockResolvedValue({ enrollment: 'closed', feed: 'closed', publishing: 'closed' });
    await getBusinessCommunityStatus('biz-1');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/community/business/status', { businessId: 'biz-1' });
  });
  it('a failed or refused read is unavailable, never an error page and never an open state', async () => {
    api.mockRejectedValue(new Error('403'));
    expect(await getBusinessCommunityStatus('biz-1')).toEqual({ state: 'unavailable' });
  });
});
