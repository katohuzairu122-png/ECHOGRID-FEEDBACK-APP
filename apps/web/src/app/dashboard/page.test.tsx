import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ business: vi.fn(), access: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }); },
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/lib/permissions', async () => ({
  ...(await vi.importActual<object>('@/lib/workspace-access')),
  getMyAccess: () => m.access(),
}));
vi.mock('@/components/workspace/restricted-panel', () => ({ RestrictedPanel: ({ variant }: { variant: string }) => <p>restricted:{variant}</p> }));
vi.mock('./create-business-form', () => ({ CreateBusinessForm: () => <p>onboarding-form</p> }));

import DashboardEntryPage from './page';

const as = (known: boolean, ...permissions: string[]) => m.access.mockResolvedValue({ known, permissions: new Set(permissions) });
const destination = async () => {
  try { render(await DashboardEntryPage()); return null; } catch (error) { return (error as { to?: string }).to ?? 'ERROR'; }
};

beforeEach(() => { vi.clearAllMocks(); m.business.mockResolvedValue({ id: 'biz-1', name: 'Hub' }); });

describe('/dashboard: the role-aware business entry (BCOMM-01)', () => {
  it('owner and manager land on the Community hub', async () => {
    as(true, 'business:view', 'business:manage_settings', 'analytics:view', 'loyalty:serve'); // owner
    expect(await destination()).toBe('/dashboard/community');
    as(true, 'business:view', 'feedback:manage', 'analytics:view'); // manager
    expect(await destination()).toBe('/dashboard/community');
  });

  it('the cashier still lands on Serve customers, never on Community', async () => {
    as(true, 'business:view', 'branches:view', 'loyalty:serve');
    expect(await destination()).toBe('/dashboard/loyalty/scan');
  });

  it('mandatory onboarding is never bypassed: with no business the entry renders the creation form and redirects nowhere', async () => {
    m.business.mockResolvedValue(null);
    expect(await destination()).toBeNull();
    expect(screen.getByText('onboarding-form')).toBeInTheDocument();
    expect(m.access).not.toHaveBeenCalled(); // not even a permission read before the business exists
  });

  it('unconfirmed permissions show the unavailable state (no redirect, so no loop and nothing assumed)', async () => {
    as(false, 'business:manage_settings');
    expect(await destination()).toBeNull();
    expect(screen.getByText('restricted:unavailable')).toBeInTheDocument();
  });

  it('a management user without a hub permission goes to the Business Overview', async () => {
    as(true, 'business:view', 'feedback:view', 'messages:view');
    expect(await destination()).toBe('/dashboard/overview');
  });

  it('no destination ever redirects back to /dashboard (no redirect loop)', async () => {
    for (const permissions of [['business:manage_settings'], ['loyalty:serve'], ['feedback:view'], ['analytics:view', 'loyalty:serve']]) {
      as(true, ...permissions);
      expect(await destination()).not.toBe('/dashboard');
    }
  });
});
