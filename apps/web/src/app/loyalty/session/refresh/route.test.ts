import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ refresh: vi.fn(), mark: vi.fn(async () => {}) }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/customer-session-refresh', () => ({ refreshRotatingCustomerSession: h.refresh }));
vi.mock('@/lib/customer-session', () => ({ markCustomerRefreshed: h.mark }));
vi.mock('@/lib/customer-api-client', () => ({ CUSTOMER_LOGIN_PATH: '/loyalty/login' }));

import { NextRequest } from 'next/server';
import { GET } from './route';

const req = (query: string, headers: Record<string, string> = {}) =>
  new NextRequest(`https://app.example.test/loyalty/session/refresh${query}`, { headers });
const location = (r: Response) => new URL(r.headers.get('location')!, 'https://app.example.test');

beforeEach(() => vi.clearAllMocks());

describe('GET /loyalty/session/refresh', () => {
  it('on success marks the refresh and returns to the requested same-origin path', async () => {
    h.refresh.mockResolvedValue('refreshed');
    const r = await GET(req('?next=%2Floyalty%2Fdashboard%2Fwallet', { 'sec-fetch-site': 'same-origin' }));
    expect(r.status).toBe(303);
    expect(location(r).pathname).toBe('/loyalty/dashboard/wallet');
    expect(h.mark).toHaveBeenCalledTimes(1);
  });
  it('a concurrent-refresh conflict returns to the page (the winner already set the cookies) and marks the refresh to bound retries', async () => {
    h.refresh.mockResolvedValue('conflict');
    const r = await GET(req('?next=%2Floyalty%2Fdashboard%2Fwallet', { 'sec-fetch-site': 'same-origin' }));
    expect(location(r).pathname).toBe('/loyalty/dashboard/wallet');
    expect(h.mark).toHaveBeenCalledTimes(1);
  });
  it('an invalid or unavailable refresh goes to sign-in carrying next, and marks nothing', async () => {
    for (const outcome of ['invalid', 'unavailable']) {
      h.refresh.mockResolvedValue(outcome);
      const r = await GET(req('?next=%2Floyalty%2Fdashboard'));
      expect(location(r).pathname).toBe('/loyalty/login');
      expect(location(r).searchParams.get('next')).toBe('/loyalty/dashboard');
    }
    expect(h.mark).not.toHaveBeenCalled();
  });
  it('refuses a cross-site navigation without touching the session', async () => {
    const r = await GET(req('?next=%2Floyalty%2Fdashboard', { 'sec-fetch-site': 'cross-site' }));
    expect(location(r).pathname).toBe('/loyalty/login');
    expect(h.refresh).not.toHaveBeenCalled();
  });
  it('never redirects off-site: an unsafe next falls back to the dashboard', async () => {
    h.refresh.mockResolvedValue('refreshed');
    for (const next of ['https://evil.example/', '//evil.example', '/\\evil.example']) {
      const r = await GET(req(`?next=${encodeURIComponent(next)}`));
      expect(location(r).origin).toBe('https://app.example.test');
      expect(location(r).pathname).toBe('/loyalty/dashboard');
    }
  });
});
