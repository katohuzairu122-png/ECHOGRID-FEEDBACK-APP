import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LoyaltySubnavLinks } from './loyalty-subnav-links';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/loyalty/rewards/reward-1' }));

describe('LoyaltySubnavLinks', () => {
  it('marks the active loyalty subsection on detail pages', () => {
    render(<LoyaltySubnavLinks items={[{ href: '/dashboard/loyalty', label: 'Accounts' }, { href: '/dashboard/loyalty/rewards', label: 'Rewards' }]} />);
    expect(screen.getByRole('link', { name: 'Rewards' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Accounts' })).not.toHaveAttribute('aria-current');
  });
});
