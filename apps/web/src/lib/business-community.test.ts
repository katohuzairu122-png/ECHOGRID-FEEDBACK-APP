import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const api = vi.hoisted(() => vi.fn());
vi.mock('./api-client', () => ({ apiFetch: api }));

import { getBusinessCommunityStatus, parseCommunityParticipation, parseCommunityStatus } from './business-community';

beforeEach(() => vi.clearAllMocks());

describe('Community rollout status (fails closed: an unread state never looks open)', () => {
  it('accepts exactly the three-field shape the API returns', () => {
    expect(parseCommunityStatus({ enrollment: 'open', feed: 'closed', publishing: 'open', distribution: 'closed' })).toEqual({ state: 'ready', status: { enrollment: 'open', feed: 'closed', publishing: 'open', distribution: 'closed' } });
  });
  it('anything else is unavailable: null, wrong types, unknown states, and a publishing state other than closed (it is not implemented)', () => {
    for (const bad of [null, undefined, 'open', 7, {}, { enrollment: 'open' }, { enrollment: 'maybe', feed: 'closed', publishing: 'closed', distribution: 'closed' },
      { enrollment: 'open', feed: true, publishing: 'closed', distribution: 'closed' }, { enrollment: 'closed', feed: 'closed', publishing: 'open' },
      { enrollment: 'closed', feed: 'closed', publishing: 'closed', distribution: 'maybe' }]) {
      expect(parseCommunityStatus(bad), JSON.stringify(bad)).toEqual({ state: 'unavailable' });
    }
  });
  it('reads only the read-only status route for the named business', async () => {
    api.mockResolvedValue({ enrollment: 'closed', feed: 'closed', publishing: 'closed', distribution: 'closed' });
    await getBusinessCommunityStatus('biz-1');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/community/business/status', { businessId: 'biz-1' });
  });
  it('a failed or refused read is unavailable, never an error page and never an open state', async () => {
    api.mockRejectedValue(new Error('403'));
    expect(await getBusinessCommunityStatus('biz-1')).toEqual({ state: 'unavailable' });
  });
});

describe('parseCommunityParticipation (BCOMM-02)', () => {
  const shown = (value: number) => ({ state: 'shown', value });
  const hidden = { state: 'suppressed' };
  const ok = { minimumGroupSize: 10, eligible: shown(50), participants: shown(20), ratePercent: shown(40) };

  it('accepts the documented shape, shown and suppressed figures alike', () => {
    expect(parseCommunityParticipation(ok)).toEqual({ state: 'ready', data: ok });
    const small = { minimumGroupSize: 10, eligible: hidden, participants: hidden, ratePercent: hidden };
    expect(parseCommunityParticipation(small)).toEqual({ state: 'ready', data: small });
  });

  it('treats anything else as unavailable (fail closed)', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}, { ...ok, minimumGroupSize: 9 }, { ...ok, minimumGroupSize: 10.5 }, { ...ok, eligible: shown(-1) },
      { ...ok, eligible: shown(1.5) }, { ...ok, participants: { state: 'shown' } }, { ...ok, participants: { state: 'other' } },
      { ...ok, ratePercent: shown(101) }, { ...ok, ratePercent: undefined }]) {
      expect(parseCommunityParticipation(bad), JSON.stringify(bad)).toEqual({ state: 'unavailable' });
    }
  });
});
