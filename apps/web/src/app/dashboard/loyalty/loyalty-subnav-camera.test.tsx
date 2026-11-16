import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard/loyalty' }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <a data-client-nav="true" {...props}>
      {children}
    </a>
  ),
}));

import { LoyaltySubnavLinks } from './loyalty-subnav-links';

describe('LoyaltySubnavLinks camera entry', () => {
  it('enters the customer-QR scanner with a full page load so its camera permission applies, and keeps client navigation elsewhere', () => {
    const { container } = render(
      <nav>
        <LoyaltySubnavLinks
          items={[
            { href: '/dashboard/loyalty', label: 'Accounts' },
            { href: '/dashboard/loyalty/scan', label: 'Customer QR' },
          ]}
        />
      </nav>,
    );
    expect(container.querySelector('a[href="/dashboard/loyalty/scan"]')!.getAttribute('data-client-nav')).toBeNull();
    expect(container.querySelector('a[href="/dashboard/loyalty"]')!.getAttribute('data-client-nav')).toBe('true');
    expect(container.querySelector('a[href="/dashboard/loyalty"]')).toHaveAttribute('aria-current', 'page');
  });
});
