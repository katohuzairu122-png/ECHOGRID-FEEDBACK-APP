import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';
import type { CommunityFeedItem } from '@/lib/community-feed-types';
import { CommunityFeedView } from './community-feed-view';

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const { recordLinkOpen } = vi.hoisted(() => ({ recordLinkOpen: vi.fn() }));
vi.mock('@/lib/actions/community-follows', () => ({ setFollowAction: vi.fn(), recordLinkOpenAction: recordLinkOpen }));
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

  it('offers an explicit account verification handoff, preserving the Feed cursor without redirecting', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'verification_required' }} cursor="older_page-2" />);
    expect(screen.getByRole('status')).toHaveTextContent('Current Community policy requires a verified phone to view the feed.');
    expect(screen.getByRole('link', { name: 'Verify phone in your account' })).toHaveAttribute(
      'href', '/loyalty/dashboard/phone?next=%2Floyalty%2Fdashboard%2Fcommunity%2Ffeed%3Fcursor%3Dolder_page-2',
    );
    expect(screen.getByRole('link', { name: 'Points & Membership' })).toHaveAttribute('href', '/loyalty/dashboard/community');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does not trust a return target or verification flag in a cursor', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'verification_required' }} cursor="//evil.test?verified=true" />);
    expect(screen.getByRole('link', { name: 'Verify phone in your account' })).toHaveAttribute(
      'href', '/loyalty/dashboard/phone?next=%2Floyalty%2Fdashboard%2Fcommunity%2Ffeed',
    );
  });

  it('reports forbidden without a retry action', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'forbidden' }} cursor="older" />);
    expect(screen.getByRole('status')).toHaveTextContent('not available with your current access');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Latest updates' })).not.toBeInTheDocument();
  });
});

describe('CommunityFeedView follows (BCOMM-04)', () => {
  const HANDLE = 'AbCdEfGhIjKlMnOpQrStUv';
  const business = (over: Partial<CommunityFeedItem> = {}) => item({ contentClass: 'business_post', businessName: 'Cafe Aroma', businessHandle: HANDLE, body: 'Fresh croissants.', linkUrl: null, ...over });
  const page = (items: CommunityFeedItem[]) => ({ status: 'ready' as const, data: { items, nextCursor: null } });

  it('offers Follow on a business post (not on an official one), Following when already followed, and nothing when the state is unknown', () => {
    const { unmount } = renderWithIntl(<CommunityFeedView result={page([item(), business()])} followed={new Set()} />);
    expect(screen.getAllByRole('button', { name: /Follow/ })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Follow Cafe Aroma' })).toHaveAttribute('aria-pressed', 'false');
    unmount();
    const followed = renderWithIntl(<CommunityFeedView result={page([business()])} followed={new Set([HANDLE])} />);
    expect(screen.getByRole('button', { name: 'Stop following Cafe Aroma' })).toHaveAttribute('aria-pressed', 'true');
    followed.unmount();
    renderWithIntl(<CommunityFeedView result={page([business()])} followed={null} />);
    expect(screen.queryByRole('button', { name: /ollow/ })).toBeNull(); // unknown state: no control that could lie
  });

  it('has an All / Following switch with the current view marked; the Following view says plainly that a follow is not a membership', () => {
    renderWithIntl(<CommunityFeedView result={page([])} filter="following" followed={new Set()} />);
    const nav = screen.getByRole('navigation', { name: 'Feed view' });
    expect(within(nav).getByRole('link', { name: 'Following' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'All updates' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText(/does not sign you up for its loyalty program, share your details or send you messages/)).toBeInTheDocument();
  });

  it('keeps the Following view when loading more', () => {
    renderWithIntl(<CommunityFeedView result={{ status: 'ready', data: { items: [business()], nextCursor: 'abc_123' } }} filter="following" followed={new Set([HANDLE])} />);
    expect(screen.getByRole('link', { name: 'Load more' })).toHaveAttribute('href', '/loyalty/dashboard/community/feed?filter=following&cursor=abc_123');
  });
});

describe('CommunityFeedView link engagement (BCOMM-05)', () => {
  const HANDLE = 'AbCdEfGhIjKlMnOpQrStUv';
  beforeEach(() => recordLinkOpen.mockClear());
  it('opening a BUSINESS post link is noted once per click; an official post link is never tracked; the link itself stays https and safe', () => {
    renderWithIntl(
      <CommunityFeedView result={{ status: 'ready', data: { items: [
        item({ handle: 'abcdefghijklmnopqrstuv', contentClass: 'business_post', businessName: 'Cafe', businessHandle: HANDLE, linkUrl: 'https://cafe.example/menu' }),
        item({ handle: 'zzzzzzzzzzzzzzzzzzzzzz', linkUrl: 'https://echogrid.example/news' }),
      ], nextCursor: null } }} followed={new Set()} />,
    );
    const links = screen.getAllByRole('link', { name: 'Open link' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    fireEvent.click(links[0]!);
    expect(recordLinkOpen).toHaveBeenCalledWith('abcdefghijklmnopqrstuv');
    recordLinkOpen.mockClear();
    fireEvent.click(links[1]!);
    expect(recordLinkOpen).not.toHaveBeenCalled();
  });
});
