import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { FeedbackForm } from './feedback-form';
import { submitFeedbackAction, generateFollowUpQuestionAction } from '@/lib/actions/qr-feedback';

// Server Actions can't actually run against a server inside a jsdom unit
// test -- mocked at the module boundary so FeedbackForm's OWN logic (the
// two-step gating, hidden-field carry-forward, Skip vs Submit) is what's
// under test, not the network. Real end-to-end behavior is covered instead
// by browser-driven E2E specs.
vi.mock('@/lib/actions/qr-feedback', () => ({
  submitFeedbackAction: vi.fn(),
  generateFollowUpQuestionAction: vi.fn(),
}));

describe('FeedbackForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('step 1 submits the rating and asks for a follow-up question, not the real submission', async () => {
    const user = userEvent.setup();
    vi.mocked(generateFollowUpQuestionAction).mockResolvedValue({
      ready: true,
      question: 'What made this great?',
      rating: 5,
      comment: 'Loved it',
    });

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" />);

    await user.click(screen.getByRole('radio', { name: '5 stars' }));
    await user.type(screen.getByLabelText('Comments (optional)'), 'Loved it');
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(generateFollowUpQuestionAction).toHaveBeenCalled());
    expect(submitFeedbackAction).not.toHaveBeenCalled();
  });

  it('step 2 shows the AI question with Skip and Submit when one comes back', async () => {
    const user = userEvent.setup();
    vi.mocked(generateFollowUpQuestionAction).mockResolvedValue({
      ready: true,
      question: 'What made this great?',
      rating: 5,
    });
    vi.mocked(submitFeedbackAction).mockResolvedValue({ success: true });

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" />);

    await user.click(screen.getByRole('radio', { name: '5 stars' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText('What made this great?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit feedback' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));
    await waitFor(() => expect(submitFeedbackAction).toHaveBeenCalled());
  });

  it('step 2 shows only Submit when no question comes back (AI call failed/rate-limited)', async () => {
    const user = userEvent.setup();
    vi.mocked(generateFollowUpQuestionAction).mockResolvedValue({
      ready: true,
      question: undefined,
      rating: 4,
    });
    vi.mocked(submitFeedbackAction).mockResolvedValue({ success: true });

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" />);

    await user.click(screen.getByRole('radio', { name: '4 stars' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit feedback' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  it('shows the thank-you screen after a successful submission', async () => {
    const user = userEvent.setup();
    vi.mocked(generateFollowUpQuestionAction).mockResolvedValue({
      ready: true,
      question: undefined,
      rating: 5,
    });
    vi.mocked(submitFeedbackAction).mockResolvedValue({ success: true });

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" />);

    await user.click(screen.getByRole('radio', { name: '5 stars' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Submit feedback' }));

    expect(await screen.findByText('Thank you!')).toBeInTheDocument();
  });
});
