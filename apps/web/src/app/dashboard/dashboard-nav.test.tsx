import { render, screen } from '@testing-library/react';
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
const owner = {
  known: true,
  permissions: new Set(['loyalty:manage', 'rewards:manage', 'analytics:view', 'team:view']),
};
const cashier = {
  known: true,
  permissions: new Set(['loyalty:view', 'loyalty:manage', 'feedback:view', 'messages:view']),
};

describe('DashboardNav presentation', () => {
  it('cashier: Serve customers is the home and only primary tab; configuration is not shown', async () => {
    vi.mocked(getMyAccess).mockResolvedValue(cashier);
    const { container } = render(await DashboardNav());
    const sidebar = container.querySelector('aside nav')!;
    const bar = container.querySelector('nav[class*="bottomNav"]')!;
    const hrefs = (el: Element) =>
      Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs(bar)).toEqual(['/dashboard/loyalty/scan']);
    expect(hrefs(sidebar)).toEqual([
      '/dashboard/loyalty/scan',
      '/dashboard/loyalty',
      '/dashboard/feedback',
      '/dashboard/messages',
      '/support',
    ]);
    for (const hidden of [
      '/dashboard/analytics',
      '/dashboard/settings',
      '/dashboard/settings/team',
      '/dashboard/billing',
      '/dashboard/branches',
      '/dashboard/loyalty/tiers',
    ])
      expect(sidebar.querySelector('a[href="' + hidden + '"]')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'nav.more' }));
    expect(
      screen.getByRole('dialog').querySelector('a[href="/dashboard/loyalty"]'),
    ).toBeInTheDocument();
  });

  it('an unreadable permission set never turns an owner into a cashier', async () => {
    vi.mocked(getMyAccess).mockResolvedValue({ known: false, permissions: new Set() });
    const { container } = render(await DashboardNav());
    expect(container.querySelector('aside nav a[href="/dashboard/analytics"]')).toBeInTheDocument();
  });

  it('preserves every operational destination in the vertical sidebar and full mobile menu', async () => {
    vi.mocked(getMyAccess).mockResolvedValue(owner);
    const { container } = render(await DashboardNav());
    const sidebar = container.querySelector('aside nav')!;
    const user = userEvent.setup();
    const bar = container.querySelector('nav[class*="bottomNav"]')!;
    expect(Array.from(bar.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      '/dashboard',
      '/dashboard/loyalty/scan', // cashier "Serve customers" tab is a primary destination
      '/dashboard/feedback',
      '/dashboard/loyalty',
    ]);
    await user.click(screen.getByRole('button', { name: 'nav.more' }));
    const sheet = screen.getByRole('dialog');
    for (const href of [
      '/dashboard',
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
});
