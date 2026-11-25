import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test-utils';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardNav } from './dashboard-nav';
import type * as Permissions from '@/lib/permissions';
import { getMyAccess } from '@/lib/permissions';

vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock('@/lib/permissions', async () => ({
  ...(await vi.importActual<typeof Permissions>('@/lib/permissions')),
  getMyAccess: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/actions/auth', () => ({ logoutAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: vi.fn() }),
}));
const FULL = [
  'business:view',
  'branches:view',
  'feedback:view',
  'loyalty:view',
  'loyalty:manage',
  'loyalty:serve',
  'loyalty:accounts:view',
  'loyalty:adjust',
  'messages:view',
  'messages:send',
  'rewards:manage',
  'analytics:view',
  'notifications:view',
  'business:manage_settings',
  'team:view',
  'billing:view',
  'settlement:view',
];
const owner = { known: true, permissions: new Set(FULL) };
// Default Staff (cashier) grants after D-C1, and the pre-D-C1 default (an unreconciled role).
const cashier = {
  known: true,
  permissions: new Set(['business:view', 'branches:view', 'loyalty:serve']),
};
const legacyCashier = {
  known: true,
  permissions: new Set([
    'business:view',
    'branches:view',
    'feedback:view',
    'loyalty:view',
    'loyalty:manage',
    'messages:view',
    'messages:send',
  ]),
};
const hrefs = (el: Element) =>
  Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
const ADMIN = [
  '/dashboard/community',
  '/dashboard/overview',
  '/dashboard/loyalty',
  '/dashboard/feedback',
  '/dashboard/messages',
  '/dashboard/analytics',
  '/dashboard/branches',
  '/dashboard/settlements',
  '/dashboard/notifications',
  '/dashboard/settings',
  '/dashboard/settings/team',
  '/dashboard/billing',
  '/dashboard/loyalty/tiers',
  '/dashboard/loyalty/rewards',
];

describe('DashboardNav presentation', () => {
  it('cashier: Serve customers is the only workspace; the More menu has no administrative destination', async () => {
    vi.mocked(getMyAccess).mockResolvedValue(cashier);
    const { container } = render(await DashboardNav());
    const sidebar = container.querySelector('aside nav')!;
    const bar = container.querySelector('nav[class*="bottomNav"]')!;
    expect(hrefs(bar)).toEqual(['/dashboard/loyalty/scan']);
    expect(hrefs(sidebar)).toEqual(['/dashboard/loyalty/scan', '/dashboard/cashier', '/support']);
    await userEvent.setup().click(screen.getByRole('button', { name: 'nav.more' }));
    const sheet = screen.getByRole('dialog');
    // The cashier app entry is a counter tool, not an administrative destination.
    expect(hrefs(sheet)).toEqual(['/dashboard/cashier', '/support']);
    expect(sheet.querySelectorAll('form')).toHaveLength(1); // sign out stays available
    for (const href of ADMIN) {
      expect(sidebar.querySelector('a[href="' + href + '"]')).not.toBeInTheDocument();
      expect(sheet.querySelector('a[href="' + href + '"]')).not.toBeInTheDocument();
    }
  });

  it('an unreconciled legacy cashier still sees only Serve customers and Support', async () => {
    vi.mocked(getMyAccess).mockResolvedValue(legacyCashier);
    const { container } = render(await DashboardNav());
    expect(hrefs(container.querySelector('aside nav')!)).toEqual([
      '/dashboard/loyalty/scan',
      '/dashboard/cashier',
      '/support',
    ]);
  });

  it('unavailable permissions: no privileged destination is shown and sign-out remains', async () => {
    vi.mocked(getMyAccess).mockResolvedValue({ known: false, permissions: new Set() });
    const { container } = render(await DashboardNav());
    expect(hrefs(container.querySelector('aside nav')!)).toEqual(['/support']);
    const nav = container.querySelector('aside nav')!;
    for (const href of [...ADMIN, '/dashboard/loyalty/scan'])
      expect(nav.querySelector('a[href="' + href + '"]')).not.toBeInTheDocument();
    expect(container.querySelectorAll('aside form')).toHaveLength(1);
  });

  it('Surveys appears only with survey:view', async () => {
    vi.mocked(getMyAccess).mockResolvedValue({ known: true, permissions: new Set([...FULL, 'survey:view']) });
    const withView = render(await DashboardNav());
    expect(withView.container.querySelector('aside nav a[href="/dashboard/surveys"]')).toBeInTheDocument();
    withView.unmount();

    vi.mocked(getMyAccess).mockResolvedValue(owner);
    const withoutView = render(await DashboardNav());
    expect(withoutView.container.querySelector('aside nav a[href="/dashboard/surveys"]')).not.toBeInTheDocument();
  });

  it('manager without billing:view or team grants does not see billing or team', async () => {
    vi.mocked(getMyAccess).mockResolvedValue({
      known: true,
      permissions: new Set(FULL.filter((p) => p !== 'billing:view' && p !== 'team:view')),
    });
    const { container } = render(await DashboardNav());
    const sidebar = container.querySelector('aside nav')!;
    expect(sidebar.querySelector('a[href="/dashboard/billing"]')).not.toBeInTheDocument();
    expect(sidebar.querySelector('a[href="/dashboard/settings/team"]')).not.toBeInTheDocument();
    expect(sidebar.querySelector('a[href="/dashboard/analytics"]')).toBeInTheDocument();
  });

  it('preserves every operational destination in the vertical sidebar and full mobile menu', async () => {
    vi.mocked(getMyAccess).mockResolvedValue(owner);
    const { container } = render(await DashboardNav());
    const sidebar = container.querySelector('aside nav')!;
    const user = userEvent.setup();
    const bar = container.querySelector('nav[class*="bottomNav"]')!;
    // BCOMM-01: the mobile bar reads Community, Loyalty (customers and rewards live inside it), Feedback, then More.
    expect(Array.from(bar.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard/community',
      '/dashboard/loyalty',
      '/dashboard/feedback',
    ]);
    await user.click(screen.getByRole('button', { name: 'nav.more' }));
    const sheet = screen.getByRole('dialog');
    for (const href of [
      '/dashboard/community',
      '/dashboard/overview', // the Business Overview stays reachable
      '/dashboard/branches',
      '/dashboard/feedback',
      '/dashboard/loyalty',
      '/dashboard/loyalty/scan',
      '/dashboard/settlements',
      '/dashboard/messages',
      '/dashboard/analytics',
      '/dashboard/notifications',
      '/dashboard/settings',
      '/dashboard/settings/team',
      '/dashboard/billing',
      '/dashboard/cashier',
      '/support',
    ]) {
      expect(sidebar.querySelector('a[href="' + href + '"]')).toBeInTheDocument();
      expect(
        bar.querySelector('a[href="' + href + '"]') ??
          sheet.querySelector('a[href="' + href + '"]'),
      ).toBeInTheDocument();
    }
    expect(container.querySelectorAll('aside form')).toHaveLength(1);
    expect(sheet.querySelectorAll('form')).toHaveLength(1);
  });

  describe('BCOMM-01: the Community entry', () => {
    const sidebarHrefs = async (access: { known: boolean; permissions: Set<string> }) => {
      vi.mocked(getMyAccess).mockResolvedValue(access);
      const { container } = render(await DashboardNav());
      return { container, hrefs: hrefs(container.querySelector('aside nav')!) };
    };
    const manager = { known: true, permissions: new Set(['business:view', 'branches:view', 'feedback:view', 'feedback:manage', 'analytics:view', 'loyalty:view']) };
    const viewer = { known: true, permissions: new Set(['business:view', 'branches:view', 'feedback:view', 'messages:view']) };

    it('owner: Community is the FIRST primary entry and appears exactly once; the Overview has its own destination', async () => {
      const { container, hrefs: links } = await sidebarHrefs(owner);
      expect(links[0]).toBe('/dashboard/community');
      expect(links.filter((h) => h === '/dashboard/community')).toHaveLength(1);
      expect(links.filter((h) => h === '/dashboard/overview')).toHaveLength(1);
      expect(links).not.toContain('/dashboard'); // the entry route is not a second, duplicate destination
      expect(container.querySelector('aside a[href="/dashboard/community"]')).toBeInTheDocument(); // the workspace home link
      expect(new Set(links).size).toBe(links.length); // no duplicate entries anywhere
    });

    it('manager (existing management permissions, no escalation): Community first, billing and team still hidden', async () => {
      const { hrefs: links } = await sidebarHrefs(manager);
      expect(links[0]).toBe('/dashboard/community');
      expect(links).toContain('/dashboard/analytics');
      expect(links).not.toContain('/dashboard/billing');
      expect(links).not.toContain('/dashboard/settings/team');
    });

    it('a view-only management user without a hub permission gets no Community entry and the Overview as home', async () => {
      const { container, hrefs: links } = await sidebarHrefs(viewer);
      expect(links).not.toContain('/dashboard/community');
      expect(links).toContain('/dashboard/overview');
      expect(container.querySelector('aside a[href="/dashboard/overview"]')).toBeInTheDocument();
    });

    it('cashier, legacy cashier and unavailable permissions never get a Community entry (navigation is not the only guard: the page and API enforce it)', async () => {
      for (const access of [cashier, legacyCashier, { known: false, permissions: new Set<string>() }]) {
        const { hrefs: links } = await sidebarHrefs(access);
        expect(links).not.toContain('/dashboard/community');
        expect(links).not.toContain('/dashboard/overview');
      }
    });
  });
});
