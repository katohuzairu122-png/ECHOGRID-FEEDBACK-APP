import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import LoginPage from './page';
import { loginAction } from '@/lib/actions/auth';

// Only the error path is unit-tested here -- a successful login calls
// Next.js's redirect(), which throws a framework-internal signal that
// needs a real Next.js request context to resolve correctly. Verifying an
// actual signup/login/redirect round trip is e2e/branch-management.spec.ts's
// job, not this layer's.
vi.mock('@/lib/actions/auth', () => ({
  loginAction: vi.fn(),
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the error returned by loginAction instead of silently doing nothing', async () => {
    const user = userEvent.setup();
    vi.mocked(loginAction).mockResolvedValue({ error: 'Invalid email or password.' });

    renderWithIntl(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.');
  });

  it('marks email and password as required so the browser blocks an empty submit', () => {
    renderWithIntl(<LoginPage />);
    expect(screen.getByLabelText('Email')).toBeRequired();
    expect(screen.getByLabelText('Password')).toBeRequired();
  });

  /** The entry point to the whole recovery flow -- without this link the
   * Block 1.5 API is unreachable for the users who need it most. */
  it('offers a route into password recovery', () => {
    renderWithIntl(<LoginPage />);
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });
});
