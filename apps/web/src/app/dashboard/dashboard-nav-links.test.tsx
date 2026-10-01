import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DashboardNavLinks, getActiveDashboardNavHref, isDashboardNavItemActive } from './dashboard-nav-links';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/feedback/forms' }));

const items = [
  { href: '/dashboard/feedback', label: 'Feedback' },
  { href: '/dashboard/analytics', label: 'Analytics' },
];

describe('DashboardNavLinks', () => {
  it('marks a parent tab active throughout its nested routes', () => {
    render(<DashboardNavLinks items={items} />);

    expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Analytics' })).not.toHaveAttribute('aria-current');
  });

  it('does not activate routes that only share a string prefix', () => {
    expect(isDashboardNavItemActive('/dashboard/feedback-export', '/dashboard/feedback')).toBe(false);
  });

  it('selects only the most specific nested navigation item', () => {
    expect(getActiveDashboardNavHref('/dashboard/settings/team', [
      { href: '/dashboard/settings', label: 'Settings' },
      { href: '/dashboard/settings/team', label: 'Team' },
    ])).toBe('/dashboard/settings/team');
  });
});


