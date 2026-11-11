import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api-client';
import { ApiError } from './api-error';
import { getBusinessOverview, trendTotals } from './business-overview';

vi.mock('server-only', () => ({}));
vi.mock('./api-client', async () => ({
  apiFetch: vi.fn(),
  ApiError: (await import('./api-error')).ApiError,
}));
vi.mock('next/navigation', () => ({
  redirect: () => {
    throw new Error('NEXT_REDIRECT');
  },
}));

describe('business overview read boundary', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });
  it('scopes all five reads to the server-selected business and bypasses shared caching', async () => {
    vi.mocked(apiFetch).mockResolvedValue([]);
    await getBusinessOverview('business-a');
    expect(apiFetch).toHaveBeenCalledTimes(5);
    for (const [, options] of vi.mocked(apiFetch).mock.calls) {
      expect(options).toEqual({ businessId: 'business-a', cache: 'no-store' });
    }
    expect(apiFetch).toHaveBeenCalledWith(
      '/feedback?limit=5&offset=0&savedView=high_priority_unresolved',
      expect.anything(),
    );
  });
  it('does not make an unscoped read', async () => {
    await expect(getBusinessOverview('')).rejects.toThrow('Business scope is required');
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it('keeps unavailable and denied sections separate from real empty results', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) => {
      if (path === '/analytics/trends') throw new ApiError('Denied', 403);
      if (path === '/branches') throw new Error('offline');
      return [];
    });
    const result = await getBusinessOverview('business-a');
    expect(result.trend).toEqual({ status: 'forbidden' });
    expect(result.branches).toEqual({ status: 'unavailable' });
    expect(result.loyalty).toEqual({ status: 'ready', data: [] });
  });
  it('returns to login on authentication expiry instead of manufacturing empty data', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new ApiError('Expired', 401));
    await expect(getBusinessOverview('business-a')).rejects.toThrow('NEXT_REDIRECT');
  });
  it('derives sentiment only from real classified counts and leaves empty percentages undefined', () => {
    expect(trendTotals([])).toEqual({
      total: 0,
      positive: 0,
      neutral: 0,
      negative: 0,
      positiveRate: null,
      negativeRate: null,
    });
    expect(trendTotals([{ bucket: '2026-11-10', positive: 3, neutral: 2, negative: 1 }])).toEqual({
      total: 6,
      positive: 3,
      neutral: 2,
      negative: 1,
      positiveRate: 0.5,
      negativeRate: 1 / 6,
    });
  });
  it("applies a branch filter only to branch-scoped reads, after validating it against the caller's branches", async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) =>
      path === '/branches' ? [{ id: 'br-1' }, { id: 'br-2' }] : [],
    );
    const result = await getBusinessOverview('business-a', 'br-2');
    const paths = vi.mocked(apiFetch).mock.calls.map(([p]) => p);
    expect(result.branchFilter).toEqual({ status: 'active', branchId: 'br-2' });
    expect(paths).toContain('/analytics/trends?branchId=br-2');
    expect(paths).toContain('/feedback?limit=5&offset=0&branchId=br-2');
    expect(paths).toContain('/loyalty/accounts?limit=5');
    expect(paths.filter((p) => p === '/branches')).toHaveLength(1);
  });
  it('never forwards a branch id the caller cannot see', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path) =>
      path === '/branches' ? [{ id: 'br-1' }] : [],
    );
    const result = await getBusinessOverview('business-a', 'foreign');
    expect(result.branchFilter).toEqual({ status: 'invalid' });
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).includes('foreign'))).toBe(false);
  });
});
