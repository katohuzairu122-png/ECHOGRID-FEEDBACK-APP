import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { publicApiFetch } from './public-api-client';
import { COMMUNITY_PAGE_SIZE, getCommunityHub } from './community-hub';

vi.mock('server-only', () => ({}));
vi.mock('./customer-api-client', () => ({ customerApiFetch: vi.fn() }));
vi.mock('./public-api-client', () => ({ publicApiFetch: vi.fn() }));

const customer = vi.mocked(customerApiFetch);
const pub = vi.mocked(publicApiFetch);
const ok = (path: string) => {
  if (path === '/community/me') return { membership: null, account: null };
  if (path === '/community-points/me') return { account: null };
  return { transactions: [], pagination: { limit: 20, offset: 0, returned: 0 } };
};

describe('getCommunityHub (existing customer GET endpoints only)', () => {
  beforeEach(() => {
    customer.mockReset();
    pub.mockReset();
  });

  it('reads exactly two existing customer endpoints, all GET, with the API paging parameters', async () => {
    customer.mockImplementation(async (path) => ok(path) as never);
    await getCommunityHub(40);
    const calls = customer.mock.calls.map(([path, init]) => [path, init?.method ?? 'GET']);
    expect(calls).toEqual([
      ['/community/me', 'GET'],
      [`/community-points/me/transactions?limit=${COMMUNITY_PAGE_SIZE}&offset=40`, 'GET'],
    ]);
  });

  it('keeps an absent membership absent (null), never inventing a member or a zero balance', async () => {
    customer.mockImplementation(async (path) => ok(path) as never);
    const hub = await getCommunityHub();
    expect(hub.membership).toEqual({ status: 'ready', data: { membership: null, account: null } });
    expect(hub.points).toEqual({ status: 'ready', data: { account: null } });
    expect(customer).not.toHaveBeenCalledWith('/community-points/me', expect.anything());
  });

  it('reports 403 as forbidden and any other failure as unavailable, per section', async () => {
    customer.mockImplementation(async (path) => {
      if (path === '/community/me') throw new ApiError('no', 403);
      throw new Error('network down');
    });
    const hub = await getCommunityHub();
    expect(hub.membership).toEqual({ status: 'forbidden' });
    expect(hub.points).toEqual({ status: 'forbidden' });
    expect(hub.transactions).toEqual({ status: 'unavailable' });
  });

  it('treats a rate-limit (429) response as unavailable, never as an empty ledger or zero balance', async () => {
    customer.mockRejectedValue(new ApiError('Too many requests', 429));
    const hub = await getCommunityHub();
    expect(hub.membership).toEqual({ status: 'unavailable' });
    expect(hub.points).toEqual({ status: 'unavailable' });
    expect(hub.transactions).toEqual({ status: 'unavailable' });
  });

  it('lets the authentication redirect (control flow) escape instead of swallowing it', async () => {
    customer.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), {
        digest: 'NEXT_REDIRECT;replace;/loyalty/login;307',
      }),
    );
    await expect(getCommunityHub()).rejects.toThrow('NEXT_REDIRECT');
  });

  it('falls back to offset 0 for an invalid offset and flags a full page as possibly having more', async () => {
    const full = Array.from({ length: COMMUNITY_PAGE_SIZE }, (_, i) => ({
      id: 't' + i,
      type: 'earn',
      points: 1,
      sourceType: 'survey_completion',
      businessId: null,
      branchId: null,
      reversalOf: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    }));
    customer.mockImplementation(
      async (path) =>
        (String(path).includes('/transactions')
          ? { transactions: full, pagination: { limit: 20, offset: 0, returned: 20 } }
          : ok(path)) as never,
    );
    const hub = await getCommunityHub(-5);
    expect(customer).toHaveBeenCalledWith(expect.stringContaining('offset=0'), expect.anything());
    expect(hub.transactions).toMatchObject({ status: 'ready', data: { hasMore: true, offset: 0 } });
  });

  it('resolves each business name once and simply omits names that fail to load', async () => {
    const rows = ['b1', 'b1', 'b2', null].map((businessId, i) => ({
      id: 't' + i,
      type: 'earn',
      points: 1,
      sourceType: 'survey_completion',
      businessId,
      branchId: null,
      reversalOf: null,
      createdAt: '2026-11-01T00:00:00.000Z',
    }));
    customer.mockImplementation(
      async (path) =>
        (String(path).includes('/transactions')
          ? { transactions: rows, pagination: { limit: 20, offset: 0, returned: 4 } }
          : ok(path)) as never,
    );
    pub.mockImplementation(async (path) => {
      if (String(path).includes('b2')) throw new Error('boom');
      return { id: 'b1', name: 'The Daily Grind' } as never;
    });
    const hub = await getCommunityHub();
    expect(pub).toHaveBeenCalledTimes(2);
    expect(hub.businessNames).toEqual({ b1: 'The Daily Grind' });
  });
});
