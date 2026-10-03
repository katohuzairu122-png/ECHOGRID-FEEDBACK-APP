import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { OtpLoginForm } from './otp-login-form';
import { requestOtpAction } from '@/lib/actions/customer-auth';

const { navigateMock } = vi.hoisted(() => ({ navigateMock: vi.fn() }));

vi.mock('@/lib/browser-navigation', () => ({
  navigateWithCommittedCookies: navigateMock,
}));

vi.mock('@/lib/actions/customer-auth', () => ({
  requestOtpAction: vi.fn(),
}));

describe('OtpLoginForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
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

  it('navigates only after the verification route has committed the customer cookie', async () => {
    const user = userEvent.setup();
    vi.mocked(requestOtpAction).mockResolvedValue({ sent: true, phone: '+15551234567' });
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    render(<OtpLoginForm next="/loyalty/qr-token?feedback=received" />);
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Verification code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        '/api/customer-auth/otp/verify',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(navigateMock).toHaveBeenCalledWith('/loyalty/qr-token?feedback=received');
    });
  });

  it('shows the error returned by the verification route on the code step', async () => {
    const user = userEvent.setup();
    vi.mocked(requestOtpAction).mockResolvedValue({ sent: true, phone: '+15551234567' });
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Code is invalid or has expired.' }),
    } as Response);

    render(<OtpLoginForm next="/loyalty/dashboard" />);
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));
    await user.type(await screen.findByLabelText('Verification code'), '000000');
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Code is invalid');
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
