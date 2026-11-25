import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import en from '../../../../messages/en/businessCommunity.json';
import dashboardEn from '../../../../messages/en/dashboard.json';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ access: vi.fn(), business: vi.fn(), api: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { to }); },
  usePathname: () => '/dashboard/community',
}));
// The REAL English copy, so the wording the Owner specified is what is asserted.
const resolve = (namespace: string, key: string) => {
  const root: Record<string, unknown> = { businessCommunity: en, dashboard: dashboardEn };
  const value = [...namespace.split('.'), ...key.split('.')].reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], root);
  if (typeof value !== 'string') throw new Error(`missing message ${namespace}.${key}`);
  return value;
};
vi.mock('next-intl/server', () => ({ getTranslations: async (namespace: string) => (key: string) => resolve(namespace, key) }));
vi.mock('next-intl', () => ({ useTranslations: (namespace: string) => (key: string) => resolve(namespace, key) }));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('@/lib/permissions', async () => ({
  ...(await vi.importActual<object>('@/lib/workspace-access')),
  getMyAccess: () => m.access(),
}));
vi.mock('@/lib/api-client', () => ({ apiFetch: m.api, ApiError: class extends Error {} }));
vi.mock('@/components/workspace/restricted-panel', () => ({ RestrictedPanel: ({ variant }: { variant: string }) => <p>restricted:{variant}</p> }));

import CommunityLayout from './layout';
import CommunityHomePage from './page';
import CommunityParticipationPage from './participation/page';
import CommunityPostsPage from './posts/page';
import CommunityInsightsPage from './insights/page';

const owner = () => m.access.mockResolvedValue({ known: true, permissions: new Set(['business:view', 'business:manage_settings', 'analytics:view', 'loyalty:serve']) });
const status = (enrollment: string, feed: string, publishing = 'closed') => m.api.mockResolvedValue({ enrollment, feed, publishing });
const text = () => document.body.textContent ?? '';

beforeEach(() => {
  vi.clearAllMocks();
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

  it('opening it is read-only: exactly one GET of the status route, no write, no other call', async () => {
    render(await CommunityHomePage());
    expect(m.api).toHaveBeenCalledTimes(1);
    expect(m.api).toHaveBeenCalledWith('/community/business/status', { businessId: 'biz-1' });
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
  it('Participation: only the three aggregate headings, all unavailable; no customer-level wording or API call', async () => {
    render(await CommunityParticipationPage());
    const grid = screen.getByTestId('community-participation');
    for (const label of ['Loyalty customers', 'Community participants', 'Participation rate']) expect(within(grid).getByText(label)).toBeInTheDocument();
    expect(within(grid).getAllByText('Not available yet')).toHaveLength(3);
    expect(screen.getByText(/Small groups will be hidden so that no one can be identified/)).toBeInTheDocument();
    expect(text()).not.toMatch(/\d/);
    expect(m.api).not.toHaveBeenCalled();
  });

  it('My Posts: controlled unavailable state; no editor, no input, no button, no submission, no API call', async () => {
    render(await CommunityPostsPage());
    expect(screen.getByText('Business posts are not available yet')).toBeInTheDocument();
    expect(screen.getByText(/Nothing can be written or published today/)).toBeInTheDocument();
    expect(document.querySelectorAll('input, textarea, select, button, form')).toHaveLength(0);
    const states = within(screen.getByTestId('community-posts-states')).getAllByRole('listitem').map((li) => li.textContent);
    expect(states).toEqual(['Drafts', 'Published', 'Under review', 'Archived']);
    expect(text()).not.toMatch(/\d/);
    expect(m.api).not.toHaveBeenCalled();
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
