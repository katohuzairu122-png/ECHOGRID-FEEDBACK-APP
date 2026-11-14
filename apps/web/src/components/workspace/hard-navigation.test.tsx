import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

/**
 * SEC-CASHIER-R2 F9: the QR scanner page needs the camera, whose permission policy is fixed when a document loads. A
 * client-side (Next Link) transition into it keeps the previous page's policy, so the entry must be a full page load.
 */
vi.mock('next/navigation', () => ({ usePathname: () => '/dashboard' }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <a data-client-nav="true" {...props}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/unread-store', () => ({ useUnreadCount: () => 0, subscribeUnread: () => () => undefined }));

import { WorkspaceNavigation } from './workspace-navigation';

const props = { home: '/dashboard', label: 'w', menuLabel: 'm', moreLabel: 'more', closeLabel: 'close', utilities: null };

describe('workspace navigation entries that need a fresh document', () => {
  it('renders a plain anchor (full page load) for hardNavigation items and client navigation for the rest', () => {
    const { container } = render(
      <WorkspaceNavigation
        {...props}
        items={[
          { href: '/dashboard', label: 'Home', icon: 'store' },
          { href: '/dashboard/loyalty/scan', label: 'Serve', icon: 'qr', hardNavigation: true },
        ]}
      />,
    );
    const scan = container.querySelector('aside a[href="/dashboard/loyalty/scan"]')!;
    const home = container.querySelector('aside a[href="/dashboard"]')!;
    expect(scan).not.toBeNull();
    expect(scan.getAttribute('data-client-nav')).toBeNull();
    expect(home.getAttribute('data-client-nav')).toBe('true');
  });
});
