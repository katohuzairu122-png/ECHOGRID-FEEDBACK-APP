import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { OtpLoginForm } from './otp-login-form';
import { requestOtpAction, verifyOtpAction } from '@/lib/actions/customer-auth';

// Server Actions can't run against a server inside jsdom -- mocked at the
// module boundary so this test covers OtpLoginForm's OWN logic (which step
// renders, phone carried forward into the verify form, error surfacing),
// not the network. Same reasoning as branch-form-dialog.test.tsx.
vi.mock('@/lib/actions/customer-auth', () => ({
  requestOtpAction: vi.fn(),
  verifyOtpAction: vi.fn(),
}));

describe('OtpLoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts on the phone-entry step, not the code-entry step', () => {
    render(<OtpLoginForm next="/loyalty/dashboard" />);
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });

  it('advances to the code-entry step after a successful OTP request, carrying the phone number forward', async () => {
    const user = userEvent.setup();
    vi.mocked(requestOtpAction).mockResolvedValue({ sent: true, phone: '+15551234567' });

    render(<OtpLoginForm next="/loyalty/dashboard" />);
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.getByText(/\+15551234567/)).toBeInTheDocument();
  });

  it('shows the error returned by requestOtpAction without advancing to the code step', async () => {
    const user = userEvent.setup();
    vi.mocked(requestOtpAction).mockResolvedValue({ error: 'Too many requests. Please try again shortly.' });

    render(<OtpLoginForm next="/loyalty/dashboard" />);
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests');
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });

  it('shows the error returned by verifyOtpAction on the code step without crashing', async () => {
    const user = userEvent.setup();
    vi.mocked(requestOtpAction).mockResolvedValue({ sent: true, phone: '+15551234567' });
    vi.mocked(verifyOtpAction).mockResolvedValue({ error: 'Code is invalid or has expired.' });

    render(<OtpLoginForm next="/loyalty/dashboard" />);
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await screen.findByLabelText('Verification code');

    await user.type(screen.getByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(verifyOtpAction).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toHaveTextContent('Code is invalid');
  });
});
