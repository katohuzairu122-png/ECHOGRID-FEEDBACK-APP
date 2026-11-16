import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';

const nav = vi.hoisted(() => ({ pathname: '/loyalty/dashboard/community' }));
vi.mock('next/navigation', () => ({ usePathname: () => nav.pathname }));

import { CommunitySectionNav } from './community-section-nav';

describe('CommunitySectionNav', () => {
  beforeEach(() => {
    nav.pathname = '/loyalty/dashboard/community';
  });

  it('offers exactly the two sections as real links inside a labelled navigation', () => {
    renderWithIntl(<CommunitySectionNav showFeed />);
    const region = screen.getByRole('navigation', { name: 'Community sections' });
    expect(region).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Points & Membership', 'Feed']);
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/loyalty/dashboard/community',
      '/loyalty/dashboard/community/feed',
    ]);
  });

  it('marks Points & Membership current on the Community root', () => {
    renderWithIntl(<CommunitySectionNav showFeed />);
    expect(screen.getByRole('link', { name: 'Points & Membership' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Feed' })).not.toHaveAttribute('aria-current');
  });

  it('marks Feed current on the feed route (deep link)', () => {
    nav.pathname = '/loyalty/dashboard/community/feed';
    renderWithIntl(<CommunitySectionNav showFeed />);
    expect(screen.getByRole('link', { name: 'Feed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Points & Membership' })).not.toHaveAttribute('aria-current');
  });
});

describe('Feed flag', () => {
  it('renders no section control at all while the Feed is disabled', () => {
    const { container } = renderWithIntl(<CommunitySectionNav showFeed={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('link', { name: 'Feed' })).not.toBeInTheDocument();
  });
});

describe('CommunityLayout', () => {
  it('frames the sections with the control when the Feed is enabled, and hides it when disabled', async () => {
    vi.doMock('@/lib/network-status', () => ({ getNetworkFeedEnabled: async () => true }));
    const { default: CommunityLayout } = await import('./layout');
    renderWithIntl(await CommunityLayout({ children: <p>Section content</p> }));
    expect(screen.getByRole('navigation', { name: 'Community sections' })).toBeInTheDocument();
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });

  it('shows only the content (no section control, no Feed link) when disabled', async () => {
    vi.resetModules();
    vi.doMock('@/lib/network-status', () => ({ getNetworkFeedEnabled: async () => false }));
    const { default: CommunityLayout } = await import('./layout');
    const { CommunitySectionNav: Fresh } = await import('./community-section-nav');
    void Fresh;
    renderWithIntl(await CommunityLayout({ children: <p>Only points</p> }));
    expect(screen.queryByRole('navigation', { name: 'Community sections' })).not.toBeInTheDocument();
    expect(screen.getByText('Only points')).toBeInTheDocument();
  });
});
