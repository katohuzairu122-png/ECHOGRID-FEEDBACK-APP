import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import type { FeedbackDto } from '@echo-grid-feedback/shared-types';
import { FeedbackInboxList } from './feedback-inbox-list';
import { bulkAssignToMeAction, bulkMarkReviewedAction, markReviewedAction, deleteFeedbackAction } from '@/lib/actions/feedback';

vi.mock('@/lib/actions/feedback', () => ({
  markReviewedAction: vi.fn(),
  deleteFeedbackAction: vi.fn(),
  bulkAssignToMeAction: vi.fn(),
  bulkMarkReviewedAction: vi.fn(),
}));

function makeItem(overrides: Partial<FeedbackDto> = {}): FeedbackDto {
  return {
    id: 'f-1',
    businessId: 'b-1',
    branchId: 'br-1',
    qrCodeId: 'qr-1',
    rating: 4,
    comment: 'Great visit',
    customerName: null,
    customerEmail: null,
    customerPhone: null,
    followUpQuestion: null,
    followUpAnswer: null,
    status: 'new',
    sentiment: 'positive',
    sentimentScore: 0.5,
    analysisStatus: 'completed',
    analyzedAt: null,
    category: 'compliment',
    urgency: 'P3_LOW',
    assignedTo: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const branchNames = new Map([['br-1', 'Main St']]);

describe('FeedbackInboxList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing for an empty item list -- the caller shows the empty-state card instead', () => {
    const { container } = renderWithIntl(<FeedbackInboxList items={[]} branchNames={branchNames} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows urgency and category badges for a classified item', () => {
    renderWithIntl(
      <FeedbackInboxList items={[makeItem({ urgency: 'P0_CRITICAL', category: 'safety' })]} branchNames={branchNames} />,
    );
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('Safety')).toBeInTheDocument();
  });

  it('does not show the bulk action bar until at least one row is selected', () => {
    renderWithIntl(<FeedbackInboxList items={[makeItem()]} branchNames={branchNames} />);
    expect(screen.queryByRole('button', { name: 'Assign selected to me' })).not.toBeInTheDocument();
  });

  it('selecting a row shows the bulk bar with a count of 1, and bulk-assigns just that id', async () => {
    const user = userEvent.setup();
    vi.mocked(bulkAssignToMeAction).mockResolvedValue(undefined);

    renderWithIntl(<FeedbackInboxList items={[makeItem({ id: 'f-1' }), makeItem({ id: 'f-2' })]} branchNames={branchNames} />);

    // Index 0 is "select all"; row checkboxes follow in item order. Each
    // row's own aria-label is unique (rating + date) so a screen reader can
    // tell rows apart, but that also makes it a poor query target here.
    const checkboxes = screen.getAllByRole('checkbox');
    await user.click(checkboxes[1]!);
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Assign selected to me' }));
    await waitFor(() => expect(bulkAssignToMeAction).toHaveBeenCalledWith(['f-1']));

    // Selection clears after the action completes.
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('"select all" selects every row, and bulk-mark-reviewed sends every id -- distinct label from the per-row "Mark reviewed" button so the two are never ambiguous on screen together', async () => {
    const user = userEvent.setup();
    vi.mocked(bulkMarkReviewedAction).mockResolvedValue(undefined);

    renderWithIntl(<FeedbackInboxList items={[makeItem({ id: 'f-1' }), makeItem({ id: 'f-2' })]} branchNames={branchNames} />);

    await user.click(screen.getByRole('checkbox', { name: 'Select all feedback on this page' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Mark selected as reviewed' }));
    await waitFor(() => expect(bulkMarkReviewedAction).toHaveBeenCalledWith(['f-1', 'f-2']));

    // The two per-row "Mark reviewed" buttons are still there, unaffected.
    expect(screen.getAllByRole('button', { name: 'Mark reviewed' })).toHaveLength(2);
  });

  it('clear selection empties the set without calling any action', async () => {
    const user = userEvent.setup();
    renderWithIntl(<FeedbackInboxList items={[makeItem()]} branchNames={branchNames} />);

    await user.click(screen.getAllByRole('checkbox')[1]!); // index 0 is "select all"
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    expect(bulkAssignToMeAction).not.toHaveBeenCalled();
    expect(bulkMarkReviewedAction).not.toHaveBeenCalled();
  });

  it('shows "Assigned to you" when the item is assigned to the current user, and "Assigned" otherwise', () => {
    renderWithIntl(
      <FeedbackInboxList
        items={[makeItem({ id: 'f-1', assignedTo: 'user-1' }), makeItem({ id: 'f-2', assignedTo: 'user-2' })]}
        branchNames={branchNames}
        currentUserId="user-1"
      />,
    );
    expect(screen.getByText('Assigned to you')).toBeInTheDocument();
    expect(screen.getByText('Assigned')).toBeInTheDocument();
  });

  it('per-row actions (mark reviewed/delete) still work unchanged, delegated to FeedbackActions', async () => {
    const user = userEvent.setup();
    vi.mocked(markReviewedAction).mockResolvedValue(undefined);

    renderWithIntl(<FeedbackInboxList items={[makeItem({ status: 'new' })]} branchNames={branchNames} />);
    await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));

    await waitFor(() => expect(markReviewedAction).toHaveBeenCalledWith('f-1'));
    expect(deleteFeedbackAction).not.toHaveBeenCalled();
  });
});
