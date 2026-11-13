import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import type { FeedbackDto } from '@echo-grid-feedback/shared-types';
import { FeedbackInboxList } from './feedback-inbox-list';
import { FeedbackFilters } from './feedback-filters';
import { BranchFilter } from './branch-filter';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('next-intl/server', async () => {
  const en = (await import('../../../../messages/en/feedback.json')).default;
  return {
    getTranslations: async (ns: string) => {
      const scope = ns
        .split('.')
        .slice(1)
        .reduce<Record<string, unknown>>((o, k) => o[k] as never, en as never);
      return (key: string) => scope[key] as string;
    },
  };
});
vi.mock('@/lib/actions/feedback', () => ({
  markReviewedAction: vi.fn(),
  deleteFeedbackAction: vi.fn(),
  bulkAssignToMeAction: vi.fn(),
  bulkMarkReviewedAction: vi.fn(),
}));

function item(overrides: Partial<FeedbackDto> = {}): FeedbackDto {
  return {
    id: 'f-1',
    businessId: 'b-1',
    branchId: 'br-1',
    qrCodeId: 'qr-1',
    rating: 2,
    comment: 'Slow service',
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    followUpQuestion: null,
    followUpAnswer: null,
    status: 'new',
    sentiment: 'negative',
    sentimentScore: -0.5,
    analysisStatus: 'completed',
    analyzedAt: null,
    category: 'service_quality',
    urgency: 'P1_HIGH',
    assignedTo: null,
    isDuplicateText: false,
    duplicateTextCount: 0,
    nearDuplicateCount: 0,
    createdAt: '2026-11-10T10:00:00.000Z',
    ...overrides,
  };
}
const branches = new Map([['br-1', 'Main St']]);

describe('Feedback Inbox visual alignment (presentation only)', () => {
  beforeEach(() => push.mockClear());

  it('keeps urgency, sentiment, rating and workflow status as distinct, labelled fields', () => {
    renderWithIntl(<FeedbackInboxList items={[item()]} branchNames={branches} />);
    const card = screen.getByRole('article');
    expect(card).toHaveAttribute('data-urgency', 'P1_HIGH');
    expect(card).toHaveAttribute('data-status', 'new');
    expect(within(card).getByText('High').closest('span')).toHaveTextContent('Urgency: High');
    expect(within(card).getByText('Negative').closest('span')).toHaveTextContent(
      'Sentiment: Negative',
    );
    expect(within(card).getByText('New').closest('span')).toHaveTextContent('Status: New');
    expect(within(card).getByRole('img', { name: '2 out of 5 stars' })).toBeInTheDocument();
  });

  it('never fabricates a sentiment: null/unknown shows nothing, pending/failed analysis show their real state', () => {
    renderWithIntl(
      <FeedbackInboxList
        items={[
          item({ id: 'a', sentiment: null, analysisStatus: 'completed', urgency: null }),
          item({ id: 'b', sentiment: 'unknown', analysisStatus: 'completed' }),
          item({ id: 'c', sentiment: null, analysisStatus: 'pending' }),
          item({ id: 'd', sentiment: null, analysisStatus: 'failed' }),
        ]}
        branchNames={branches}
      />,
    );
    expect(screen.queryByText('Neutral')).not.toBeInTheDocument();
    expect(screen.queryByText('Positive')).not.toBeInTheDocument();
    expect(screen.queryAllByText(/Sentiment:/)).toHaveLength(0);
    expect(screen.getByText('Analysis pending')).toBeInTheDocument();
    expect(screen.getByText('Analysis failed')).toBeInTheDocument();
    expect(screen.getAllByRole('article')[0]).not.toHaveAttribute('data-urgency');
  });

  it('shows the real timestamp and branch, and the list item count on this page', () => {
    renderWithIntl(
      <FeedbackInboxList items={[item(), item({ id: 'f-2' })]} branchNames={branches} />,
    );
    expect(screen.getAllByText(/Main St/)).toHaveLength(2);
    expect(document.querySelector('time')).toHaveAttribute('datetime', '2026-11-10T10:00:00.000Z');
    expect(screen.getByText('2 feedback items on this page')).toBeInTheDocument();
  });

  it('announces the bulk selection bar as a labelled region only while rows are selected', async () => {
    const user = userEvent.setup();
    renderWithIntl(<FeedbackInboxList items={[item()]} branchNames={branches} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('checkbox')[1]!);
    expect(screen.getByRole('region', { name: '1 selected' })).toBeInTheDocument();
  });

  it('search form is a labelled landmark; submit keeps other params and resets paging; clear keeps scope', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FeedbackFilters
        search=""
        savedView="critical_now"
        category={[]}
        urgency={[]}
        baseParams={{ branchId: 'br-1' }}
      />,
    );
    expect(screen.getByRole('search', { name: 'Search and filters' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search comments'), 'late');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    const url = new URL(push.mock.calls[0]![0] as string, 'http://x');
    expect(url.searchParams.get('search')).toBe('late');
    expect(url.searchParams.get('branchId')).toBe('br-1');
    expect(url.searchParams.get('savedView')).toBe('critical_now');
    expect(url.searchParams.has('offset')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    const cleared = new URL(push.mock.calls[1]![0] as string, 'http://x');
    expect(cleared.searchParams.has('search')).toBe(false);
    expect(cleared.searchParams.get('branchId')).toBe('br-1');
  });

  it('branch filter has a visible label and navigates by branch id', async () => {
    const user = userEvent.setup();
    renderWithIntl(<BranchFilter branches={[{ id: 'br-1', name: 'Main St' } as never]} />);
    expect(screen.getByText('Branch')).toBeInTheDocument();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by branch' }), 'br-1');
    expect(push).toHaveBeenCalledWith('/dashboard/feedback?branchId=br-1');
  });

  it('view, category and urgency are single-choice dropdowns that apply on change and keep the other filters', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FeedbackFilters
        search="late"
        savedView="critical_now"
        category={[]}
        urgency={['P1_HIGH']}
        baseParams={{ branchId: 'br-1' }}
      />,
    );
    for (const name of ['View', 'Category', 'Urgency']) {
      const select = screen.getByRole('combobox', { name });
      expect(select).not.toHaveAttribute('multiple');
    }
    expect(screen.getByRole('combobox', { name: 'View' })).toHaveValue('critical_now');
    expect(screen.getByRole('combobox', { name: 'Urgency' })).toHaveValue('P1_HIGH');
    expect(within(screen.getByRole('combobox', { name: 'View' })).getAllByRole('option')).toHaveLength(9);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'service_quality');
    const url = new URL(push.mock.calls.at(-1)![0] as string, 'http://x');
    expect(url.searchParams.getAll('category')).toEqual(['service_quality']);
    expect(url.searchParams.get('urgency')).toBe('P1_HIGH');
    expect(url.searchParams.get('savedView')).toBe('critical_now');
    expect(url.searchParams.get('branchId')).toBe('br-1');
    expect(url.searchParams.get('search')).toBe('late');
    expect(url.searchParams.has('offset')).toBe(false);
  });

  it('choosing "All" in a dropdown removes that filter only', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FeedbackFilters
        savedView="critical_now"
        category={['service_quality']}
        urgency={[]}
        baseParams={{ branchId: 'br-1' }}
      />,
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'View' }), '');
    const url = new URL(push.mock.calls.at(-1)![0] as string, 'http://x');
    expect(url.searchParams.has('savedView')).toBe(false);
    expect(url.searchParams.getAll('category')).toEqual(['service_quality']);
    expect(url.searchParams.get('branchId')).toBe('br-1');
  });

  it('shows the first value of an old multi-value link and replaces it with one choice', async () => {
    const user = userEvent.setup();
    renderWithIntl(
      <FeedbackFilters category={['service_quality', 'cleanliness']} urgency={[]} baseParams={{}} />,
    );
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('service_quality');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Urgency' }), 'P1_HIGH');
    const url = new URL(push.mock.calls.at(-1)![0] as string, 'http://x');
    expect(url.searchParams.getAll('category')).toEqual(['service_quality']);
  });
});
