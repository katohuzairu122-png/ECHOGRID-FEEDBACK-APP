import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PlatformNavLinks } from './platform-nav-links';

vi.mock('next/navigation', () => ({ usePathname: () => '/platform/billing/plans' }));

describe('PlatformNavLinks', () => {
  it('keeps the owning tab active on a nested route', () => {
    render(<PlatformNavLinks items={[{ href: '/platform/businesses', label: 'Directory' }, { href: '/platform/billing', label: 'Billing' }]} />);
    expect(screen.getByRole('link', { name: 'Billing' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Directory' })).not.toHaveAttribute('aria-current');
  });
});
