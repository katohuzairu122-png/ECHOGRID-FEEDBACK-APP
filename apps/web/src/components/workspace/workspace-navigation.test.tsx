import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  activeWorkspaceHref,
  WorkspaceNavigation,
  type WorkspaceNavItem,
} from './workspace-navigation';

const state = vi.hoisted(() => ({ pathname: '/dashboard/loyalty/scan' }));
vi.mock('next/navigation', () => ({ usePathname: () => state.pathname }));
const items: WorkspaceNavItem[] = [
  { href: '/dashboard', label: 'Overview', icon: 'store' },
  { href: '/dashboard/feedback', label: 'Feedback', icon: 'chat' },
  { href: '/dashboard/loyalty', label: 'Loyalty', icon: 'star' },
  { href: '/dashboard/loyalty/scan', label: 'Scan', icon: 'qr' },
  { href: '/dashboard/settings', label: 'Settings', icon: 'settings' },
];
describe('shared workspace navigation', () => {
  beforeEach(() => {
    state.pathname = '/dashboard/loyalty/scan';
  });
  it('selects the most specific route without marking every parent as current', () => {
    expect(activeWorkspaceHref(state.pathname, items)).toBe('/dashboard/loyalty/scan');
    expect(activeWorkspaceHref('/dashboarding', items)).toBeUndefined();
  });
  it('keeps every destination and existing utility available in the sidebar', () => {
    const { container } = render(
      <WorkspaceNavigation
        items={items}
        home="/dashboard"
        label="Business"
        menuLabel="Menu"
        utilities={<button>Log out</button>}
      />,
    );
    const sidebar = within(container.querySelector('aside')!);
    for (const item of items)
      expect(sidebar.getByRole('link', { name: item.label })).toHaveAttribute('href', item.href);
    expect(sidebar.getByRole('link', { name: 'Scan' })).toHaveAttribute('aria-current', 'page');
    expect(sidebar.getByRole('link', { name: 'Loyalty' })).not.toHaveAttribute('aria-current');
    expect(sidebar.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Business' }).querySelectorAll('a')).toHaveLength(
      4,
    );
  });
  it('supports the full mobile menu, Escape dismissal and focus restoration', async () => {
    const { container } = render(
      <WorkspaceNavigation
        items={items}
        home="/dashboard"
        label="Business"
        menuLabel="Menu"
        utilities={<button>Log out</button>}
      />,
    );
    const menu = container.querySelector('details')!;
    const summary = menu.querySelector('summary')!;
    const user = userEvent.setup();
    await user.click(summary);
    expect(menu.open).toBe(true);
    expect(within(menu).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/dashboard/settings',
    );
    await user.keyboard('{Escape}');
    expect(menu.open).toBe(false);
    expect(summary).toHaveFocus();
  });
});
