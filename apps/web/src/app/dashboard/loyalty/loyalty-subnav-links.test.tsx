import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoyaltySubnavLinks } from './loyalty-subnav-links';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/loyalty/rewards/reward-1' }));

describe('LoyaltySubnavLinks', () => {
  it('marks the most specific active loyalty subsection on detail pages, preserving all links', () => {
    render(
      <nav aria-label="Loyalty sections">
        <LoyaltySubnavLinks items={[
          { href: '/dashboard/loyalty', label: 'Accounts' },
          { href: '/dashboard/loyalty/tiers', label: 'Tiers' },
          { href: '/dashboard/loyalty/rewards', label: 'Rewards' },
          { href: '/dashboard/loyalty/scan', label: 'Customer QR' },
          { href: '/dashboard/settlements', label: 'Orphan settlement' },
        ]} />
      </nav>,
    );
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(5);
    expect(screen.getByRole('navigation', { name: 'Loyalty sections' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Rewards' })).toHaveAttribute('aria-current', 'page');
    expect(links.filter((link) => link.getAttribute('aria-current') === 'page')).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Accounts' })).not.toHaveAttribute('aria-current');
  });
});
