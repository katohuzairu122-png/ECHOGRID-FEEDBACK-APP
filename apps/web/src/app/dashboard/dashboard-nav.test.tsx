import { render } from '@testing-library/react';
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
    const mobile = container.querySelector('details nav')!;
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
      expect(mobile.querySelector('a[href="' + href + '"]')).toBeInTheDocument();
    }
    expect(container.querySelectorAll('form')).toHaveLength(2);
  });
});
