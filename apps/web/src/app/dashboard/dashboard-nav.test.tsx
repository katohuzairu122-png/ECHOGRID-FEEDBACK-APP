import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DashboardNav } from './dashboard-nav';
vi.mock('next-intl/server', () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock('@/lib/actions/auth', () => ({ logoutAction: vi.fn() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch: vi.fn() }),
}));
describe('DashboardNav presentation', () => {
  it('preserves every operational destination in the vertical sidebar and full mobile menu', async () => {
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
