import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import en from '../../../../messages/en/businessCommunity.json';
import dashboardEn from '../../../../messages/en/dashboard.json';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), business: vi.fn(), api: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }); },
  usePathname: () => '/dashboard/community',
  useRouter: () => ({ refresh: vi.fn() }),
}));
// The REAL English copy, so the wording the Owner specified is what is asserted.
const resolve = (namespace: string, key: string, values?: Record<string, unknown>) => {
  const root: Record<string, unknown> = { businessCommunity: en, dashboard: dashboardEn };
  const value = [...namespace.split('.'), ...key.split('.')].reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], root);
  if (typeof value !== 'string') throw new Error(`missing message ${namespace}.${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(values?.[name] ?? `{${name}}`));
};
vi.mock('next-intl/server', () => ({ getLocale: async () => 'en', getFormatter: async () => ({ dateTime: () => 'Jan 1, 2026' }), getTranslations: async (namespace: string) => (key: string, values?: Record<string, unknown>) => resolve(namespace, key, values) }));
vi.mock('next-intl', () => ({ useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => resolve(namespace, key, values) }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/lib/permissions', async () => ({
  ...(await vi.importActual<object>('@/lib/workspace-access')),
  getMyAccess: () => m.access(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: m.api, ApiError: class ApiError extends Error { constructor(message: string, public status = 500) { super(message); } } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/actions/business-posts', () => ({ savePostAction: vi.fn(), submitPostAction: vi.fn(), archivePostAction: vi.fn() }));
vi.mock('@/components/workspace/restricted-panel', () => ({ RestrictedPanel: ({ variant }: { variant: string }) => <p>restricted:{variant}</p> }));

import { ApiError as ApiErrorMock } from '@/lib/api-client';
import CommunityLayout from './layout';
import CommunityHomePage from './page';
import CommunityParticipationPage from './participation/page';
import CommunityPostsPage from './posts/page';
import CommunityInsightsPage from './insights/page';

const owner = () => m.access.mockResolvedValue({ known: true, permissions: new Set(['business:view', 'business:manage_settings', 'analytics:view', 'loyalty:serve']) });
// The status route and the participation route answer separately; a participation answer of `null` simulates a failed read.
let participation: unknown = null;
// The business posts route answers with a list, or fails with an HTTP status (403 = may not manage posts).
let postsAnswer: unknown = [];
let postsFailure: number | null = null;
const status = (enrollment: string, feed: string, publishing = 'closed') =>
  m.api.mockImplementation(async (path: string) => {
    if (path === '/community/business/participation') {
      if (participation === null) throw new Error('unavailable');
      return participation;
    }
    if (path === '/network/business-posts') {
      if (postsFailure !== null) throw new ApiErrorMock('failed', postsFailure);
      return postsAnswer;
    }
    return { enrollment, feed, publishing, distribution: 'closed' };
  });
const figures = (eligible: unknown, participants: unknown, ratePercent: unknown) => ({ minimumGroupSize: 10, eligible, participants, ratePercent });
const shown = (value: number) => ({ state: 'shown', value });
const hidden = { state: 'suppressed' };
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
  participation = null;
  postsAnswer = [];
  postsFailure = null;
  owner();
  m.business.mockResolvedValue({ id: 'biz-1', name: 'Buddy Coffee' });
  status('closed', 'closed');
});

describe('Community Home', () => {
  it('shows the Owner-specified identity and introduction', async () => {
    render(await CommunityHomePage());
    expect(screen.getByRole('heading', { name: 'One account. Every loyalty.' })).toBeInTheDocument();
    expect(screen.getByText('Connect with customers, grow your audience and build lasting relationships through the Echo Grid Community.')).toBeInTheDocument();
  });

  it('while Community is disabled it says so plainly, explains it, and never claims anything is operational', async () => {
    render(await CommunityHomePage());
    const rollout = screen.getByTestId('community-rollout');
    expect(rollout).toHaveAttribute('data-any-open', 'false');
    for (const row of within(rollout).getAllByRole('listitem')) expect(row).toHaveAttribute('data-state', 'closed');
    expect(within(rollout).getAllByText('Not available yet')).toHaveLength(3);
    expect(screen.getByText(/Community is not yet available\. Visiting this page does not enroll you or any customer, and nothing is published\./)).toBeInTheDocument();
    expect(screen.getByText('Community activity will appear here when Community becomes available.')).toBeInTheDocument();
    const about = screen.getByTestId('community-about');
    for (const heading of ['What it is', 'How it differs from your loyalty program', 'How your business can benefit', 'Participation is voluntary', 'Publishing, later', 'Customer privacy', 'Current availability']) {
      expect(within(about).getByText(heading)).toBeInTheDocument();
    }
    expect(text()).not.toMatch(/\bOpen\b/);
  });

  it('shows NO invented figure anywhere: the participation summary is an explicit unavailable state and the page has no digits', async () => {
    render(await CommunityHomePage());
    const summary = screen.getByTestId('community-summary');
    expect(within(summary).getAllByText('Not available yet')).toHaveLength(3);
    expect(summary.textContent).not.toMatch(/\d/);
    expect(text()).not.toMatch(/\d/); // no counts, percentages, dates or activation dates of any kind
  });

  it('reflects the real state: enrollment open shows Open, publishing is still closed, an open Feed gets an honest notice (no feed content)', async () => {
    status('open', 'open');
    render(await CommunityHomePage());
    const rollout = screen.getByTestId('community-rollout');
    expect(rollout).toHaveAttribute('data-any-open', 'true');
    expect(rollout.querySelector('[data-capability="enrollment"]')).toHaveAttribute('data-state', 'open');
    expect(rollout.querySelector('[data-capability="feed"]')).toHaveAttribute('data-state', 'open');
    expect(rollout.querySelector('[data-capability="publishing"]')).toHaveAttribute('data-state', 'closed');
    expect(screen.getByText(/Customers can now choose to join Community/)).toBeInTheDocument();
    expect(screen.getByText('The customer Community Feed is open, but activity for businesses is not available yet.')).toBeInTheDocument();
  });

  it('a status that cannot be read is "Status unavailable" for every capability, never open', async () => {
    m.api.mockRejectedValue(new Error('down'));
    render(await CommunityHomePage());
    const rollout = screen.getByTestId('community-rollout');
    expect(rollout).toHaveAttribute('data-any-open', 'false');
    expect(within(rollout).getAllByText('Status unavailable')).toHaveLength(3);
    expect(screen.getByText(/We could not read the rollout status/)).toBeInTheDocument();
  });

  it('opening it is read-only: exactly the status GET and the participation-totals GET, no write, no other call', async () => {
    render(await CommunityHomePage());
    expect(m.api).toHaveBeenCalledTimes(2);
    expect(m.api).toHaveBeenCalledWith('/community/business/status', { businessId: 'biz-1' });
    expect(m.api).toHaveBeenCalledWith('/community/business/participation', { businessId: 'biz-1' });
    expect(screen.queryAllByRole('button')).toHaveLength(0); // no non-functional or misleading action buttons
    expect(document.querySelector('form')).toBeNull();
  });

  it('links to the Business Overview and never presents draft legal text', async () => {
    render(await CommunityHomePage());
    expect(screen.getByRole('link', { name: 'Business Overview' })).toHaveAttribute('href', '/dashboard/overview');
    // Explanatory copy only: no legal terms, policy version, approval claim or consent wording (those stay in the unapproved legal drafts).
    expect(text()).not.toMatch(/\bterms\b|legally|privacy policy|policy version|I agree|I expressly/i);
  });
});

describe('the other internal sections (explicit unavailable states, no data requested)', () => {
  it('Participation: when the totals cannot be read it says so, shows no number, and requests only the totals route', async () => {
    render(await CommunityParticipationPage());
    const grid = screen.getByTestId('community-participation');
    for (const label of ['Loyalty customers', 'Community participants', 'Participation rate']) expect(within(grid).getByText(label)).toBeInTheDocument();
    expect(within(grid).getAllByText('Not available yet')).toHaveLength(3);
    expect(screen.getByText(/could not be loaded right now/)).toBeInTheDocument();
    expect(screen.getByText(/Small groups are hidden so that no one can be identified/)).toBeInTheDocument();
    expect(text()).not.toMatch(/\d/);
    expect(m.api).toHaveBeenCalledTimes(1);
    expect(m.api).toHaveBeenCalledWith('/community/business/participation', { businessId: 'biz-1' });
  });

  it('Participation: shows exactly the totals the server returned and never customer-level wording', async () => {
    participation = figures(shown(120), shown(45), shown(38));
    render(await CommunityParticipationPage());
    const grid = screen.getByTestId('community-participation');
    expect(within(grid).getByText('120')).toBeInTheDocument();
    expect(within(grid).getByText('45')).toBeInTheDocument();
    expect(within(grid).getByText('38%')).toBeInTheDocument();
    expect(text()).not.toMatch(/\b(email|phone|points balance|customer id)\b/i);
    expect(document.querySelectorAll('input, textarea, select, button, form')).toHaveLength(0);
  });

  it('Participation: a suppressed figure is explained and never rendered as a number or zero', async () => {
    participation = figures(shown(25), hidden, hidden);
    render(await CommunityParticipationPage());
    const grid = screen.getByTestId('community-participation');
    expect(within(grid).getByText('25')).toBeInTheDocument();
    expect(within(grid).getAllByText('Hidden: small group')).toHaveLength(2);
    expect(within(grid).getAllByText('Hidden to protect privacy: groups smaller than 10 are never shown.').length).toBeGreaterThan(0);
    expect(within(grid).queryByText('0')).toBeNull();
  });

  it('Participation: a malformed answer is treated as unavailable, never trusted', async () => {
    participation = { minimumGroupSize: 3, eligible: shown(5), participants: shown(5), ratePercent: shown(100) };
    render(await CommunityParticipationPage());
    expect(within(screen.getByTestId('community-participation')).getAllByText('Not available yet')).toHaveLength(3);
  });

  const HANDLE = 'AbCdEfGhIjKlMnOpQrStUv';
  const post = (over: Record<string, unknown> = {}) => ({
    handle: HANDLE, stage: 'draft', latestRevisionNo: 1, reasonCode: null, body: 'We open a second counter on Saturday.', linkUrl: null,
    contentLocale: 'en', publishedAt: null, createdAt: '2026-01-01T10:00:00.000Z', ...over,
  });

  it('My Posts (publishing closed): history is readable, nothing can be created or changed, and it says why', async () => {
    postsAnswer = [post({ stage: 'live', publishedAt: '2026-01-02T10:00:00.000Z' })];
    render(await CommunityPostsPage());
    expect(screen.getByText(/Publishing is not open yet/)).toBeInTheDocument();
    expect(screen.getByText('We open a second counter on Saturday.')).toBeInTheDocument();
    expect(document.querySelectorAll('input, textarea, select, button, form')).toHaveLength(0);
    expect(m.api).toHaveBeenCalledWith('/network/business-posts', { businessId: 'biz-1' });
  });

  it('My Posts (publishing open): the composer and per-stage actions are offered; every other call is a read', async () => {
    status('closed', 'closed', 'open');
    postsAnswer = [post(), post({ handle: 'BbCdEfGhIjKlMnOpQrStUv', stage: 'awaiting_review' }),
      post({ handle: 'CbCdEfGhIjKlMnOpQrStUv', stage: 'rejected', reasonCode: 'misleading_claim' }), post({ handle: 'DbCdEfGhIjKlMnOpQrStUv', stage: 'archived' })];
    render(await CommunityPostsPage());
    expect(screen.getByRole('button', { name: 'New post' })).toBeInTheDocument();
    const cards = screen.getAllByTestId('community-post');
    expect(cards.map((c) => c.getAttribute('data-stage'))).toEqual(['draft', 'awaiting_review', 'rejected', 'archived']);
    expect(within(cards[0]!).getByRole('button', { name: 'Submit for review' })).toBeInTheDocument();
    expect(within(cards[1]!).queryByRole('button', { name: 'Submit for review' })).toBeNull(); // awaiting review: only archive
    expect(within(cards[2]!).getByText(/Not approved: misleading claim/)).toBeInTheDocument();
    expect(within(cards[3]!).queryAllByRole('button')).toHaveLength(0); // archived is terminal
    expect(m.api.mock.calls.every(([path]) => !String(path).includes('/draft') && !String(path).includes('/submit'))).toBe(true);
  });

  it('My Posts: a user who may see Community but not manage posts is told so and sees no post data', async () => {
    postsFailure = 403;
    render(await CommunityPostsPage());
    expect(screen.getByText(/your role cannot manage posts/)).toBeInTheDocument();
    expect(document.querySelectorAll('input, textarea, select, button, form')).toHaveLength(0);
  });

  it('My Posts: a failed or malformed read is "could not be loaded", never an empty list that looks real', async () => {
    postsFailure = 500;
    render(await CommunityPostsPage());
    expect(screen.getByText(/could not be loaded right now/)).toBeInTheDocument();
    cleanup();
    postsFailure = null;
    postsAnswer = [{ handle: 'short', stage: 'draft' }];
    render(await CommunityPostsPage());
    expect(screen.getByText(/could not be loaded right now/)).toBeInTheDocument();
    expect(screen.queryByTestId('community-posts')).toBeNull();
  });

  it('Insights: nothing is measured, so no view, follower, engagement, acquisition or conversion figure exists; planned measures are plain words', async () => {
    render(await CommunityInsightsPage());
    expect(screen.getByText('Insights are not available yet')).toBeInTheDocument();
    const planned = within(screen.getByTestId('community-insights-planned')).getAllByRole('listitem').map((li) => li.textContent);
    expect(planned).toEqual(['Post impressions', 'Content engagement', 'Business profile visits', 'New followers', 'Loyalty enrollment attribution', 'Community-driven customer acquisition']);
    expect(text()).not.toMatch(/\d/);
    expect(m.api).not.toHaveBeenCalled();
  });
});

describe('access control on every section (server-side; navigation is never the only guard)', () => {
  const sections: [string, () => Promise<unknown>][] = [
    ['layout', () => CommunityLayout({ children: <p>child</p> })],
    ['home', () => CommunityHomePage()],
    ['participation', () => CommunityParticipationPage()],
    ['posts', () => CommunityPostsPage()],
    ['insights', () => CommunityInsightsPage()],
  ];

  it.each(sections)('%s: counter staff are redirected to Serve customers and nothing is read', async (_name, page) => {
    m.access.mockResolvedValue({ known: true, permissions: new Set(['business:view', 'branches:view', 'loyalty:serve']) });
    await expect(page()).rejects.toMatchObject({ to: '/dashboard/loyalty/scan' });
    expect(m.api).not.toHaveBeenCalled();
  });

  it.each(sections)('%s: unconfirmed permissions and a view-only user are refused with no data read', async (_name, page) => {
    m.access.mockResolvedValue({ known: false, permissions: new Set() });
    render((await page()) as React.ReactElement);
    expect(screen.getByText('restricted:unavailable')).toBeInTheDocument();
    m.access.mockResolvedValue({ known: true, permissions: new Set(['business:view', 'feedback:view', 'messages:view']) });
    render((await page()) as React.ReactElement);
    expect(screen.getByText('restricted:forbidden')).toBeInTheDocument();
    expect(m.api).not.toHaveBeenCalled();
  });

  it.each(sections)('%s: with no business the user goes to the /dashboard entry (onboarding), never to a Community page', async (_name, page) => {
    m.business.mockResolvedValue(null);
    await expect(page()).rejects.toMatchObject({ to: '/dashboard' });
  });
});

describe('layout', () => {
  it('shows the business name, the single Community heading and the four internal sections as one hub (not top-level navigation)', async () => {
    render(await CommunityLayout({ children: <p>child-content</p> }));
    expect(screen.getByTestId('community-business-name')).toHaveTextContent('Buddy Coffee');
    expect(screen.getByRole('heading', { level: 1, name: 'Community' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Community sections' });
    expect(within(tabs).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Home', '/dashboard/community'],
      ['Participation', '/dashboard/community/participation'],
      ['My Posts', '/dashboard/community/posts'],
      ['Insights', '/dashboard/community/insights'],
    ]);
    expect(within(tabs).getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('child-content')).toBeInTheDocument();
  });
});
