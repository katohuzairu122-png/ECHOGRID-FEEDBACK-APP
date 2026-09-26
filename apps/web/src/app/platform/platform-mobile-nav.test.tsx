import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformMobileNav } from './platform-mobile-nav';

const prefetch = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => '/platform',
  useRouter: () => ({ prefetch }),
}));

vi.mock('@/lib/actions/auth', () => ({
  logoutAction: vi.fn(),
}));

const items = [
  { href: '/platform/businesses', label: 'Directory' },
  { href: '/platform/audit-log', label: 'Audit Log' },
];

describe('PlatformMobileNav', () => {
  beforeEach(() => prefetch.mockClear());

  it('prefetches destinations when opened and closes when a link is selected', () => {
    const { container } = render(
      <PlatformMobileNav items={items} menuLabel="Admin navigation" logoutLabel="Log out" />,
    );
    const details = container.querySelector('details');
    expect(details).not.toBeNull();

    details!.open = true;
    fireEvent(details!, new Event('toggle'));
    expect(prefetch).toHaveBeenCalledWith('/platform/businesses');
    expect(prefetch).toHaveBeenCalledWith('/platform/audit-log');

    const auditLink = screen.getByRole('link', { name: 'Audit Log' });
    auditLink.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(auditLink);
    expect(details).not.toHaveAttribute('open');
  });
});
