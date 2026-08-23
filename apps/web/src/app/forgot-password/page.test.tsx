import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import ForgotPasswordPage from './page';
import { requestPasswordResetAction } from '@/lib/actions/auth';

vi.mock('@/lib/actions/auth', () => ({
  requestPasswordResetAction: vi.fn(),
}));

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the form with a confirmation once the request is accepted', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordResetAction).mockResolvedValue({ submitted: true });

    renderWithIntl(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('status')).toBeInTheDocument();
    // The form is gone, so a user cannot re-submit by reflex and burn
    // another token on the account.
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  /**
   * The browser-side half of the API's account-enumeration defence. The
   * server answers 202 for unknown addresses on purpose; if this screen
   * ever said something different for a real address than an unknown one,
   * it would hand back the oracle the API withholds. Asserting on the exact
   * hedged wording is the point -- a well-meaning copy edit to "We've sent
   * you an email" would silently reintroduce the leak.
   */
  it('confirms without claiming an account exists', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordResetAction).mockResolvedValue({ submitted: true });

    renderWithIntl(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'nobody@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/if an account exists/i);
  });

  it('shows an error returned by the action instead of silently doing nothing', async () => {
    const user = userEvent.setup();
    vi.mocked(requestPasswordResetAction).mockResolvedValue({ error: 'Too many requests.' });

    renderWithIntl(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Send reset link' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many requests.');
  });

  it('keeps a route back to log in', () => {
    renderWithIntl(<ForgotPasswordPage />);
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveAttribute('href', '/login');
  });
});
