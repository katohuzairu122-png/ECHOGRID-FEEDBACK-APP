import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { OtpLoginForm } from './otp-login-form';
import { requestOtpAction } from '@/lib/actions/customer-auth';

vi.mock('@/lib/actions/customer-auth', () => ({
  requestOtpAction: vi.fn(),
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

  it('posts verification and the QR return path as one native navigation', async () => {
    const user = userEvent.setup();
    vi.mocked(requestOtpAction).mockResolvedValue({ sent: true, phone: '+15551234567' });

    render(<OtpLoginForm next="/loyalty/qr-token?autocheckin=1&feedback=received" />);
    await user.type(screen.getByLabelText('Phone number'), '+15551234567');
    await user.click(screen.getByRole('button', { name: 'Send code' }));

    const code = await screen.findByLabelText('Verification code');
    const form = code.closest('form');
    expect(form).toHaveAttribute('action', '/api/customer-auth/otp/verify');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveFormValues({
      next: '/loyalty/qr-token?autocheckin=1&feedback=received',
      code: '',
    });
    expect(form?.querySelector('input[name="phone"]')).toBeNull();
  });

  it('keeps the customer on the code step when verification redirects back with an error', () => {
    render(
      <OtpLoginForm
        next="/loyalty/dashboard"
        initialPhone="+15551234567"
        verifyError="Code is invalid or has expired."
      />,
    );

    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Code is invalid');
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
  });
});
