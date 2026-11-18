import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { checkinAction, joinAndCheckinAction } from '@/lib/actions/loyalty-customer';
import { CheckinPanel } from './checkin-panel';

vi.mock('@/lib/actions/loyalty-customer', () => ({
  checkinAction: vi.fn(),
  joinAndCheckinAction: vi.fn(),
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

  it('joining an additional business without a verified phone shows a verify prompt that returns here, not a raw error', async () => {
    const user = userEvent.setup();
    vi.mocked(checkinAction).mockResolvedValue({ error: 'Join first.', code: 'MEMBERSHIP_REQUIRED', membershipRequired: true });
    vi.mocked(joinAndCheckinAction).mockResolvedValue({ error: 'Verify your phone number to continue.', code: 'PHONE_VERIFICATION_REQUIRED' });
    render(<CheckinPanel token="qr-token" branchName="Main branch" businessName="Echo Grid Cafe" signedIn />);
    await user.click(screen.getByRole('button', { name: 'Check in' }));
    const join = await screen.findByRole('button', { name: /Join/ });
    await user.click(screen.getByRole('checkbox'));
    await user.click(join);
    expect(await screen.findByText('Verify your phone number to join another business.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Verify my phone' })).toHaveAttribute(
      'href',
      '/loyalty/dashboard/phone?next=%2Floyalty%2Fqr-token%3Fautocheckin%3D1',
    );
    expect(screen.queryByText('Verify your phone number to continue.')).not.toBeInTheDocument();
  });

  it('asks for explicit consent to join and sends nothing until the box is ticked', async () => {
    const user = userEvent.setup();
    vi.mocked(checkinAction).mockResolvedValue({ error: 'Join first.', code: 'MEMBERSHIP_REQUIRED', membershipRequired: true });
    vi.mocked(joinAndCheckinAction).mockResolvedValue({ error: 'Verify your phone number to continue.', code: 'PHONE_VERIFICATION_REQUIRED' });
    render(<CheckinPanel token="qr-token" branchName="Main branch" businessName="Echo Grid Cafe" signedIn />);
    await user.click(screen.getByRole('button', { name: 'Check in' }));

    const join = await screen.findByRole('button', { name: /Join/ });
    const consent = screen.getByRole('checkbox', { name: /I agree to join this business's loyalty program/ });
    expect(consent).not.toBeChecked();
    expect(join).toBeDisabled();
    await user.click(join);
    expect(joinAndCheckinAction).not.toHaveBeenCalled();

    await user.click(consent);
    expect(join).toBeEnabled();
    await user.click(join);
    expect(joinAndCheckinAction).toHaveBeenCalledTimes(1);
    expect(joinAndCheckinAction).toHaveBeenCalledWith('qr-token', true);
  });
});
