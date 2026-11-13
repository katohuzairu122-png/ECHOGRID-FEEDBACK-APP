import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  customerApiFetch: vi.fn(),
  getActiveBusinessQuiet: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/lib/customer-api-client', () => ({ customerApiFetch: mocks.customerApiFetch }));
vi.mock('@/lib/business', () => ({ getActiveBusinessQuiet: mocks.getActiveBusinessQuiet }));

import { GET as staffUnread } from './messaging/unread/route';
import { GET as customerUnread } from './loyalty/unread/route';

beforeEach(() => vi.resetAllMocks());

describe('GET /api/messaging/unread (staff menu badge)', () => {
  it('returns the active business’s counts, uncached', async () => {
    mocks.getActiveBusinessQuiet.mockResolvedValue({ id: 'biz-1' });
    mocks.apiFetch.mockResolvedValue({ unreadMessages: 4, unreadConversations: 2 });
    const response = await staffUnread();
    expect(await response.json()).toEqual({ unreadMessages: 4, unreadConversations: 2 });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/messaging/unread-count',
      expect.objectContaining({ businessId: 'biz-1' }),
    );
  });

  it('answers none, without calling the API, when there is no active business', async () => {
    mocks.getActiveBusinessQuiet.mockResolvedValue(null);
    expect(await (await staffUnread()).json()).toEqual({
      unreadMessages: 0,
      unreadConversations: 0,
    });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('answers none, never an error, when the API refuses or fails (no permission, signed out, rate limited)', async () => {
    mocks.getActiveBusinessQuiet.mockResolvedValue({ id: 'biz-1' });
    mocks.apiFetch.mockRejectedValue(new Error('403'));
    const response = await staffUnread();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ unreadMessages: 0, unreadConversations: 0 });
  });

  it('never passes a negative or non-numeric count to the page', async () => {
    mocks.getActiveBusinessQuiet.mockResolvedValue({ id: 'biz-1' });
    mocks.apiFetch.mockResolvedValue({ unreadMessages: -5, unreadConversations: 'x' });
    expect(await (await staffUnread()).json()).toEqual({
      unreadMessages: 0,
      unreadConversations: 0,
    });
  });
});

describe('GET /api/loyalty/unread (customer badge)', () => {
  it('returns the customer’s counts and the per-business breakdown, uncached', async () => {
    mocks.customerApiFetch.mockResolvedValue({
      unreadMessages: 3,
      unreadConversations: 2,
      byBusiness: [
        { businessId: 'a', unreadMessages: 2 },
        { businessId: 'b', unreadMessages: 1 },
      ],
    });
    const response = await customerUnread();
    expect(await response.json()).toEqual({
      unreadMessages: 3,
      unreadConversations: 2,
      byBusiness: [
        { businessId: 'a', unreadMessages: 2 },
        { businessId: 'b', unreadMessages: 1 },
      ],
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers none, never an error or a redirect, when signed out or failing', async () => {
    mocks.customerApiFetch.mockRejectedValue(
      Object.assign(new Error('NEXT_REDIRECT'), {
        digest: 'NEXT_REDIRECT;replace;/loyalty/login;307;',
      }),
    );
    const response = await customerUnread();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      unreadMessages: 0,
      unreadConversations: 0,
      byBusiness: [],
    });
  });
});
