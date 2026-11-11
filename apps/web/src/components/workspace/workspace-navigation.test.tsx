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
  });
  const renderNav = () =>
    render(
      <WorkspaceNavigation
        items={items}
        home="/dashboard"
        label="Business"
        menuLabel="Menu"
        moreLabel="More"
        closeLabel="Close"
        utilities={<button>Log out</button>}
      />,
    );
  it('shows four primary destinations plus More in the bottom bar', () => {
    renderNav();
    const bar = screen.getByRole('navigation', { name: 'Business' });
    expect(
      within(bar)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Overview', 'Feedback', 'Loyalty', 'Scan']);
    expect(within(bar).getByRole('button', { name: 'More' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });
  it('puts overflow links and logout in the More sheet, with Escape dismissal and focus restore', async () => {
    renderNav();
    const user = userEvent.setup();
    const more = screen.getByRole('button', { name: 'More' });
    await user.click(more);
    const sheet = screen.getByRole('dialog', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(within(sheet).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'href',
      '/dashboard/settings',
    );
    expect(within(sheet).getByRole('button', { name: 'Log out' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('link', { name: 'Feedback' })).toBeNull();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(more).toHaveFocus();
  });
  it('traps Tab inside the sheet and closes via the close button', async () => {
    renderNav();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More' }));
    const sheet = screen.getByRole('dialog');
    const focusables =
      within(sheet).getAllByRole('link').length + within(sheet).getAllByRole('button').length;
    for (let i = 0; i < focusables + 2; i++) {
      await user.tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('honours primaryCount for roles with fewer destinations', () => {
    render(
      <WorkspaceNavigation
        items={items.slice(0, 3)}
        home="/"
        label="Customer"
        menuLabel="Menu"
        primaryCount={2}
        utilities={null}
      />,
    );
    expect(
      within(screen.getByRole('navigation', { name: 'Customer' })).getAllByRole('link'),
    ).toHaveLength(2);
  });
});
