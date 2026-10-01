import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { checkinAction } from '@/lib/actions/loyalty-customer';
import { CheckinPanel } from './checkin-panel';

vi.mock('@/lib/actions/loyalty-customer', () => ({
  checkinAction: vi.fn(),
}));

describe('CheckinPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the feedback thank-you above the loyalty sign-in action', () => {
    render(
      <CheckinPanel
        token="qr-token"
        branchName="Main branch"
        businessName="Echo Grid Cafe"
        signedIn={false}
        feedbackReceived
      />,
    );

    const thankYou = screen.getByText('Thank you!');
    const signIn = screen.getByRole('link', { name: 'Sign in to check in' });
    expect(thankYou.compareDocumentPosition(signIn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the API error returned by the check-in action', async () => {
    const user = userEvent.setup();
    vi.mocked(checkinAction).mockResolvedValue({
      error: 'This visit has already received loyalty points.',
    });

    render(
      <CheckinPanel
        token="qr-token"
        branchName="Main branch"
        businessName="Echo Grid Cafe"
        signedIn
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Check in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This visit has already received loyalty points.',
    );
  });
});
