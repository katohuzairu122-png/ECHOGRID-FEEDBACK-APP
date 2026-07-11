import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { FeedbackActions } from './feedback-actions';
import { markReviewedAction, deleteFeedbackAction } from '@/lib/actions/feedback';

vi.mock('@/lib/actions/feedback', () => ({
  markReviewedAction: vi.fn(),
  deleteFeedbackAction: vi.fn(),
}));

describe('FeedbackActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Mark reviewed" only for new feedback, not already-reviewed feedback', () => {
    const { rerender } = renderWithIntl(<FeedbackActions feedbackId="f-1" status="new" />);
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument();

    rerender(<FeedbackActions feedbackId="f-1" status="reviewed" />);
    expect(screen.queryByRole('button', { name: 'Mark reviewed' })).not.toBeInTheDocument();
  });

  it('calls markReviewedAction with no confirmation prompt -- lower stakes than delete', async () => {
    const user = userEvent.setup();
    vi.mocked(markReviewedAction).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');

    renderWithIntl(<FeedbackActions feedbackId="f-1" status="new" />);
    await user.click(screen.getByRole('button', { name: 'Mark reviewed' }));

    await waitFor(() => expect(markReviewedAction).toHaveBeenCalledWith('f-1'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('does nothing if the delete confirm prompt is dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithIntl(<FeedbackActions feedbackId="f-1" status="new" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteFeedbackAction).not.toHaveBeenCalled();
  });

  it('calls deleteFeedbackAction when the delete confirm prompt is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteFeedbackAction).mockResolvedValue(undefined);

    renderWithIntl(<FeedbackActions feedbackId="f-1" status="new" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteFeedbackAction).toHaveBeenCalledWith('f-1'));
  });

  it('surfaces a failed delete with an alert instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(deleteFeedbackAction).mockRejectedValue(new Error('network error'));

    renderWithIntl(<FeedbackActions feedbackId="f-1" status="new" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  });
});
