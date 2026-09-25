import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardMobileNav } from './dashboard-mobile-nav';

const prefetch = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ prefetch }),
}));

vi.mock('@/lib/actions/auth', () => ({
  logoutAction: vi.fn(),
}));

const items = [
  { href: '/dashboard/feedback', label: 'Feedback' },
  { href: '/dashboard/analytics', label: 'Analytics' },
];

describe('DashboardMobileNav', () => {
  beforeEach(() => prefetch.mockClear());

  it('prefetches destinations when opened and closes immediately when a link is selected', () => {
    const { container } = render(
      <DashboardMobileNav
        items={items}
        menuLabel="Dashboard navigation"
        logoutLabel="Log out"
        installLabel="Install app"
        installIosHint="Use Add to Home Screen"
      />,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();

    details!.open = true;
    fireEvent(details!, new Event('toggle'));
    expect(prefetch).toHaveBeenCalledWith('/dashboard/feedback');
    expect(prefetch).toHaveBeenCalledWith('/dashboard/analytics');

    const analyticsLink = screen.getByRole('link', { name: 'Analytics' });
    analyticsLink.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(analyticsLink);
    expect(details).not.toHaveAttribute('open');
  });
});
