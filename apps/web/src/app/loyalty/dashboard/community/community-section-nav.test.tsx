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
    renderWithIntl(<CommunitySectionNav />);
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
    renderWithIntl(<CommunitySectionNav />);
    expect(screen.getByRole('link', { name: 'Points & Membership' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Feed' })).not.toHaveAttribute('aria-current');
  });

  it('marks Feed current on the feed route (deep link)', () => {
    nav.pathname = '/loyalty/dashboard/community/feed';
    renderWithIntl(<CommunitySectionNav />);
    expect(screen.getByRole('link', { name: 'Feed' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Points & Membership' })).not.toHaveAttribute('aria-current');
  });
});

describe('CommunityLayout', () => {
  it('frames both sections with the section navigation and renders the section content', async () => {
    const { default: CommunityLayout } = await import('./layout');
    renderWithIntl(CommunityLayout({ children: <p>Section content</p> }));
    expect(screen.getByRole('navigation', { name: 'Community sections' })).toBeInTheDocument();
    expect(screen.getByText('Section content')).toBeInTheDocument();
  });
});
