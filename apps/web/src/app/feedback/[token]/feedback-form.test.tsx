import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { FeedbackForm } from './feedback-form';
import { submitFeedbackAction, generateFollowUpQuestionAction } from '@/lib/actions/qr-feedback';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('@/lib/browser-navigation', () => ({
  navigateWithCommittedCookies: navigateMock,
}));

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

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    await user.click(screen.getByRole('radio', { name: 'Other' }));
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

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    await user.click(screen.getByRole('radio', { name: 'Compliment' }));
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

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    await user.click(screen.getByRole('radio', { name: 'Suggestion' }));
    await user.click(screen.getByRole('radio', { name: '4 stars' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Submit feedback' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Skip' })).not.toBeInTheDocument();
  });

  it('moves the thank-you message to the loyalty destination after submission', async () => {
    const user = userEvent.setup();
    vi.mocked(generateFollowUpQuestionAction).mockResolvedValue({
      ready: true,
      question: undefined,
      rating: 5,
    });
    vi.mocked(submitFeedbackAction).mockResolvedValue({ success: true });

    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    await user.click(screen.getByRole('radio', { name: 'Compliment' }));
    await user.click(screen.getByRole('radio', { name: '5 stars' }));
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Submit feedback' }));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/loyalty/tok123?feedback=received'));
    expect(screen.queryByText('Thank you!')).not.toBeInTheDocument();
  });

  it('requires an explanation for a complaint and offers optional suggestion and advice fields', async () => {
    const user = userEvent.setup();
    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    await user.click(screen.getByRole('radio', { name: 'Complaint' }));

    expect(screen.getByLabelText('What went wrong?')).toBeRequired();
    expect(screen.getByLabelText('How could we improve? (optional)')).not.toBeRequired();
    expect(screen.getByLabelText('Any other advice? (optional)')).not.toBeRequired();
  });

  it('needs only a star rating to continue: no type, no comment', async () => {
    const user = userEvent.setup();
    const { container } = renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);
    const form = container.querySelector('form') as HTMLFormElement;

    expect(form.checkValidity()).toBe(false); // no rating yet
    for (const radio of screen.getAllByRole('radio').filter((r) => (r as HTMLInputElement).name === 'feedbackType')) {
      expect(radio).not.toBeRequired();
    }
    expect(screen.getByLabelText('Comments (optional)')).not.toBeRequired();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: '5 stars' }));
    expect(form.checkValidity()).toBe(true); // rating alone is enough
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('offers the four types as single-choice chips and lets the customer change their pick', async () => {
    const user = userEvent.setup();
    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    const compliment = screen.getByRole('radio', { name: 'Compliment' });
    const complaint = screen.getByRole('radio', { name: 'Complaint' });
    expect(screen.getByRole('radio', { name: 'Suggestion' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Other' })).toBeInTheDocument();
    await user.click(compliment);
    expect(compliment).toBeChecked();
    await user.click(complaint);
    expect(complaint).toBeChecked();
    expect(compliment).not.toBeChecked();
  });

  it('keeps the extra suggestion and advice fields inside a collapsed section', () => {
    renderWithIntl(<FeedbackForm token="tok123" branchName="Downtown" businessName="Echo Grid" submissionKey={crypto.randomUUID()} />);

    const more = screen.getByText('More details (optional)').closest('details');
    expect(more).not.toBeNull();
    expect(more).not.toHaveAttribute('open');
    expect(more).toContainElement(screen.getByLabelText('How could we improve? (optional)'));
  });
});


