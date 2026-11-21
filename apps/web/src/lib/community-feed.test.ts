import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api-error';
import { customerApiFetch } from './customer-api-client';
import { COMMUNITY_FEED_PAGE_SIZE, getCommunityFeed, sanitizeFeedCursor } from './community-feed';

vi.mock('server-only', () => ({}));
vi.mock('./customer-api-client', () => ({ customerApiFetch: vi.fn() }));

const customer = vi.mocked(customerApiFetch);

describe('getCommunityFeed (GET /network/feed only)', () => {
  beforeEach(() => customer.mockReset());

  it('reads exactly one customer-authenticated GET with the page size and no client identity', async () => {
    customer.mockResolvedValue({ items: [], nextCursor: null } as never);
    const result = await getCommunityFeed();
    expect(customer).toHaveBeenCalledTimes(1);
    expect(customer.mock.calls[0]![0]).toBe(`/network/feed?limit=${COMMUNITY_FEED_PAGE_SIZE}`);
    expect(customer.mock.calls[0]![1]?.method ?? 'GET').toBe('GET');
    expect(result).toEqual({ status: 'ready', data: { items: [], nextCursor: null } });
  });

  it('forwards a cursor', async () => {
    customer.mockResolvedValue({ items: [], nextCursor: null } as never);
    await getCommunityFeed('abc_1');
    expect(customer.mock.calls[0]![0]).toBe(`/network/feed?limit=${COMMUNITY_FEED_PAGE_SIZE}&cursor=abc_1`);
  });

  it.each([
    null,
    { items: null, nextCursor: null },
    { items: [], nextCursor: { private: 'not a cursor' } },
    { items: [{ handle: 'abcdefghijklmnopqrstuv', contentClass: 'official', businessName: null,
      body: 'Approved update', linkUrl: null, contentLocale: 'en', publishedAt: 'not-a-date' }], nextCursor: null },
  ])('recovers a malformed success response instead of passing it to rendering: %j', async (payload) => {
    customer.mockResolvedValue(payload as never);
    await expect(getCommunityFeed('current_cursor')).resolves.toEqual({ status: 'unavailable' });
  });

  it('maps 403 to forbidden and any other failure to unavailable, never to an empty feed', async () => {
    customer.mockRejectedValueOnce(new ApiError('no', 403, 'FORBIDDEN'));
    expect(await getCommunityFeed()).toEqual({ status: 'forbidden' });
    customer.mockRejectedValueOnce(new ApiError('down', 503, 'FEED_UNAVAILABLE'));
    expect(await getCommunityFeed()).toEqual({ status: 'unavailable' });
    customer.mockRejectedValueOnce(new Error('network'));
    expect(await getCommunityFeed()).toEqual({ status: 'unavailable' });
  });

  it('re-throws the login redirect (control flow) instead of swallowing it', async () => {
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), { digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;' });
    customer.mockRejectedValueOnce(redirect);
    await expect(getCommunityFeed()).rejects.toBe(redirect);
  });

  it('rejects more items than the requested page size', async () => {
    const item = { handle: 'abcdefghijklmnopqrstuv', contentClass: 'official', businessName: null,
      body: 'Approved update', linkUrl: null, contentLocale: 'en', publishedAt: '2026-11-21T10:00:00Z' };
    customer.mockResolvedValue({ items: Array.from({ length: 21 }, () => item), nextCursor: null } as never);
    expect(await getCommunityFeed()).toEqual({ status: 'unavailable' });
  });

  it('projects away internal fields and retries the same read after malformed data', async () => {
    const item = { handle: 'abcdefghijklmnopqrstuv', contentClass: 'official', businessName: null,
      body: 'Approved update', linkUrl: null, contentLocale: 'ar', publishedAt: '2026-11-21T10:00:00Z' };
    customer.mockResolvedValueOnce({ items: null, nextCursor: null } as never);
    expect(await getCommunityFeed('same_cursor')).toEqual({ status: 'unavailable' });
    customer.mockResolvedValueOnce({ items: [{ ...item, reviewerId: 'private' }], nextCursor: null, metadata: 'private' } as never);
    expect(await getCommunityFeed('same_cursor'))
      .toEqual({ status: 'ready', data: { items: [item], nextCursor: null } });
    expect(customer.mock.calls.map(([path]) => path))
      .toEqual(Array(2).fill(`/network/feed?limit=20&cursor=same_cursor`));
    expect(customer.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
});

describe('sanitizeFeedCursor', () => {
  it.each([
    ['abc_123-X', 'abc_123-X'],
    [['first', 'second'], 'first'],
  ])('accepts a well-formed cursor %j', (raw, expected) => {
    expect(sanitizeFeedCursor(raw as string)).toBe(expected);
  });
  it.each([undefined, '', 'a b', 'a/b', '../x', 'x'.repeat(201), '<script>'])('drops %j', (raw) => {
    expect(sanitizeFeedCursor(raw)).toBeNull();
  });
});
