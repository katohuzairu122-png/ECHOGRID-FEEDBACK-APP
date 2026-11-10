import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
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
    window.history.replaceState({}, '', '/login');
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

  it('toggles password visibility without submitting or losing the entered password', async () => {
    const user = userEvent.setup();
    renderWithIntl(<LoginPage />);
    const password = screen.getByLabelText('Password');
    await user.type(password, 'keep-this-password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password).toHaveAttribute('type', 'text');
    expect(password).toHaveValue('keep-this-password');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password).toHaveAttribute('type', 'password');
    expect(loginAction).not.toHaveBeenCalled();
  });

  it('blocks an invalid email and an empty password before submitting', async () => {
    const user = userEvent.setup();
    renderWithIntl(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.getByLabelText('Email')).toBeInvalid();
    expect(screen.getByLabelText('Password')).toBeInvalid();
    expect(loginAction).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions and editing while authentication is pending', async () => {
    let finish!: (value: { error: string }) => void;
    vi.mocked(loginAction).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    renderWithIntl(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(screen.getByRole('button', { name: 'Logging in…' })).toBeDisabled();
    expect(screen.getByLabelText('Email')).toBeDisabled();
    expect(screen.getByLabelText('Password')).toBeDisabled();
    await act(async () => finish({ error: 'Invalid email or password.' }));
    expect(await screen.findByRole('alert')).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
    expect(loginAction).toHaveBeenCalledOnce();
  });

  it('shows the localized service-unavailable fallback', async () => {
    vi.mocked(loginAction).mockResolvedValue({ errorKey: 'unavailable' });
    const user = userEvent.setup();
    renderWithIntl(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'user@example.com');
    await user.type(screen.getByLabelText('Password'), 'password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to sign in right now. Please try again.',
    );
  });

  it('preserves the existing internal return destination through registration', async () => {
    window.history.replaceState({}, '', '/login?next=%2Fdashboard%2Fbranches');
    renderWithIntl(<LoginPage />);
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute(
        'href',
        '/signup?next=%2Fdashboard%2Fbranches',
      ),
    );
  });

  it('rejects an external return destination and provides working home and legal links', () => {
    window.history.replaceState({}, '', '/login?next=https%3A%2F%2Fevil.test');
    renderWithIntl(<LoginPage />);
    expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute(
      'href',
      '/signup?next=%2Fdashboard',
    );
    expect(screen.getAllByRole('link', { name: /Back to home/ })[0]).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });
});
