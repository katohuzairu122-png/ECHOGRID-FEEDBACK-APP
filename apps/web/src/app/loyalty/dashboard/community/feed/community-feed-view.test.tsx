import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import type { CommunityFeedItem } from '@/lib/community-feed-types';
import { CommunityFeedView } from './community-feed-view';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
beforeEach(() => refresh.mockClear());

const item = (over: Partial<CommunityFeedItem> = {}): CommunityFeedItem => ({
  handle: 'abcdefghijklmnopqrstuv',
  contentClass: 'official',
  businessName: null,
  body: 'Welcome to the Community.',
  linkUrl: 'https://echogrid.example/news',
  contentLocale: 'en',
  publishedAt: '2026-11-16T10:00:00.000Z',
  ...over,
});

describe('CommunityFeedView', () => {
  it('shows an honest empty state, never fabricated activity', () => {
    renderWithIntl(
      <CommunityFeedView result={{ status: 'ready', data: { items: [], nextCursor: null } }} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Community feed' })).toBeInTheDocument();
    expect(screen.getByText('Nothing to show yet')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('renders accessible cards with a real time element and an https link only', () => {
    renderWithIntl(
      <CommunityFeedView
        result={{
          status: 'ready',
          data: {
            items: [
              item(),
              item({
                handle: 'bbbbbbbbbbbbbbbbbbbbbb',
                contentClass: 'business_post',
                businessName: 'The Daily Grind',
                linkUrl: 'javascript:alert(1)',
                body: 'Fresh bread',
              }),
            ],
            nextCursor: null,
          },
        }}
      />,
    );
    const list = screen.getByRole('list', { name: 'Community feed updates' });
    const cards = within(list).getAllByRole('article');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText('Echo Grid')).toBeInTheDocument();
    expect(within(cards[0]!).getByRole('link', { name: 'Open link' })).toHaveAttribute(
      'href',
      'https://echogrid.example/news',
    );
    expect(cards[0]!.querySelector('time')).toHaveAttribute('datetime', '2026-11-16T10:00:00.000Z');
    expect(within(cards[1]!).getByText('The Daily Grind')).toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('link')).not.toBeInTheDocument();
  });

  it('offers cursor paging only when the API returned a next cursor, URL-encoded', () => {
    renderWithIntl(
      <CommunityFeedView
        result={{ status: 'ready', data: { items: [item()], nextCursor: 'next_1' } }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Load more' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/community/feed?cursor=next_1',
    );
  });

  it('reports a load failure as an error with retry, never as an empty feed', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'unavailable' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('The feed could not be loaded right now.');
    expect(screen.queryByText('Nothing to show yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('refreshes the current page without replacing its cursor', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'unavailable' }} cursor="page_2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Latest updates' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/community/feed',
    );
  });

  it('offers refresh on an empty first page without a redundant latest-page link', () => {
    renderWithIntl(
      <CommunityFeedView result={{ status: 'ready', data: { items: [], nextCursor: null } }} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh feed' }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByRole('link', { name: 'Latest updates' })).not.toBeInTheDocument();
  });

  it('offers a way back from an empty older page', () => {
    renderWithIntl(
      <CommunityFeedView
        cursor="older"
        result={{ status: 'ready', data: { items: [], nextCursor: null } }}
      />,
    );
    expect(screen.getByRole('link', { name: 'Latest updates' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/community/feed',
    );
  });

  it('reports forbidden without a retry action', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'forbidden' }} cursor="older" />);
    expect(screen.getByRole('status')).toHaveTextContent('not available with your current access');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Latest updates' })).not.toBeInTheDocument();
  });
});
