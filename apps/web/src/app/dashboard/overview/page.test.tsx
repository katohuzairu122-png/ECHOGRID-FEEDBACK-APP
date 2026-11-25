import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ business: vi.fn(), access: vi.fn(), overview: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }); },
}));
vi.mock('next-intl/server', () => ({ getTranslations: async () => (k: string) => k, getFormatter: async () => ({ number: (n: number) => String(n) }) }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/lib/permissions', async () => ({
  ...(await vi.importActual<object>('@/lib/workspace-access')),
  getMyAccess: () => m.access(),
}));
vi.mock('@/lib/business-overview', () => ({ getBusinessOverview: m.overview, trendTotals: () => null }));
vi.mock('@/lib/platform', () => ({ getCurrentUser: vi.fn() }));

import BusinessOverviewPage from './page';

const as = (...permissions: string[]) => m.access.mockResolvedValue({ known: true, permissions: new Set(permissions) });
const to = async () => { try { await BusinessOverviewPage({}); return null; } catch (error) { return (error as { to?: string }).to; } };

beforeEach(() => { vi.clearAllMocks(); m.business.mockResolvedValue({ id: 'biz-1', name: 'Hub' }); });

describe('Business Overview at /dashboard/overview (moved from /dashboard, nothing removed)', () => {
  it('with no business it sends the user to the /dashboard entry, where onboarding lives, and reads nothing', async () => {
    m.business.mockResolvedValue(null);
    expect(await to()).toBe('/dashboard');
    expect(m.overview).not.toHaveBeenCalled();
  });
  it('counter staff still go to the cashier home (the guard is unchanged)', async () => {
    as('business:view', 'loyalty:serve');
    expect(await to()).toBe('/dashboard/loyalty/scan');
    expect(m.overview).not.toHaveBeenCalled();
  });
});
