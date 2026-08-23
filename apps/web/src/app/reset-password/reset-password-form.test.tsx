import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { ResetPasswordForm } from './reset-password-form';
import { resetPasswordAction } from '@/lib/actions/auth';

vi.mock('@/lib/actions/auth', () => ({
  resetPasswordAction: vi.fn(),
}));

/**
 * The form is tested rather than page.tsx itself: the page is an async
 * Server Component that awaits `searchParams`, which this layer cannot
 * render. The page's own branch (token present vs. absent) is covered by
 * the E2E suite's recovery flow, not here -- the same division login/
 * page.test.tsx documents for redirect-based paths.
 */
describe('ResetPasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits the token from the link as a hidden field', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPasswordAction).mockResolvedValue({ success: true });

    const { container } = renderWithIntl(<ResetPasswordForm token="abc123" />);
    const hidden = container.querySelector('input[name="token"]');
    expect(hidden).toHaveValue('abc123');

    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(resetPasswordAction).toHaveBeenCalled();
  });

  it('replaces the form with a confirmation and a login link on success', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPasswordAction).mockResolvedValue({ success: true });

    renderWithIntl(<ResetPasswordForm token="abc123" />);
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/signed out on every device/i);
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('surfaces an invalid/expired token error from the action', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPasswordAction).mockResolvedValue({
      error: 'This reset link is invalid or has expired.',
    });

    renderWithIntl(<ResetPasswordForm token="expired-token" />);
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This reset link is invalid or has expired.',
    );
  });

  it('surfaces a password mismatch, which the action rejects before calling the API', async () => {
    const user = userEvent.setup();
    vi.mocked(resetPasswordAction).mockResolvedValue({ error: 'Passwords do not match.' });

    renderWithIntl(<ResetPasswordForm token="abc123" />);
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-different-password-x');
    await user.click(screen.getByRole('button', { name: 'Update password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Passwords do not match.');
  });

  /** Mirrors signup's client-side floor so the reset flow cannot become the
   * easiest way to get a weak password into the system -- the same reason
   * MIN_PASSWORD_LENGTH is one shared constant on the API side. */
  it('enforces the same 12-character minimum as signup on both fields', () => {
    renderWithIntl(<ResetPasswordForm token="abc123" />);
    expect(screen.getByLabelText('New password')).toHaveAttribute('minLength', '12');
    expect(screen.getByLabelText('Confirm new password')).toHaveAttribute('minLength', '12');
  });
});
