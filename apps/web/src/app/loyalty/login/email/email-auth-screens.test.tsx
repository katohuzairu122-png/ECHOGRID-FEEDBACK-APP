import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

const h = vi.hoisted(() => ({
  login: vi.fn(),
  request: vi.fn(),
  complete: vi.fn(),
  notFound: vi.fn(() => { throw new Error('NOT_FOUND'); }),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/actions/customer-email-auth', () => ({
  loginWithEmailAction: h.login,
  requestEmailRegistrationAction: h.request,
  completeEmailRegistrationAction: h.complete,
}));
vi.mock('@/lib/actions/language', () => ({ setLanguageAction: vi.fn() }));
vi.mock('@/lib/actions/customer-auth', () => ({ requestOtpAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }), notFound: h.notFound }));
vi.mock('@/lib/customer-email-auth-client', () => ({
  isCustomerEmailAuthWebEnabled: () => process.env.CUSTOMER_EMAIL_AUTH_ENABLED === 'true',
}));

import { EmailLoginForm } from './email-login-form';
import { SignupRequestForm } from '../../signup/signup-request-form';
import { SignupVerifyForm, readChallengeFromHash } from '../../signup/verify/signup-verify-form';
import { OtpLoginForm } from '../otp-login-form';
import EmailLoginPage from './page';
import CustomerLoginPage from '../page';
import SignupPage from '../../signup/page';
import VerifyPage from '../../signup/verify/page';

const assign = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
  Object.defineProperty(window, 'location', { value: { ...window.location, assign, hash: '', pathname: '/loyalty/signup/verify', search: '' }, writable: true });
});
afterEach(() => { process.env.CUSTOMER_EMAIL_AUTH_ENABLED = ''; });

const CHALLENGE = '11111111-1111-4111-8111-111111111111.' + 'p'.repeat(40);

describe('readChallengeFromHash', () => {
  it('accepts only a well-formed challenge id and proof', () => {
    expect(readChallengeFromHash(`#c=${encodeURIComponent(CHALLENGE)}`)).toBe(CHALLENGE);
    for (const bad of ['', '#', '#c=', '#c=abc', '#x=1', `#c=${CHALLENGE}&extra=1`, '#c=%E0%A4%A']) expect(readChallengeFromHash(bad)).toBeNull();
  });
});

describe('EmailLoginForm', () => {
  it('shows a translated, non-revealing error and keeps the form', async () => {
    h.login.mockResolvedValue({ error: 'invalid_credentials' });
    render(<EmailLoginForm next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The email or password is not correct.');
    expect(assign).not.toHaveBeenCalled();
  });
  it('on success loads the destination as a fresh document', async () => {
    h.login.mockResolvedValue({ success: true, next: '/loyalty/dashboard/qr' });
    render(<EmailLoginForm next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Password'), 'right');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/loyalty/dashboard/qr'));
  });
  it('offers sign-up and the phone alternative, both keeping next', () => {
    render(<EmailLoginForm next="/loyalty/dashboard/qr" />);
    expect(screen.getByRole('link', { name: /Create an account with email/ })).toHaveAttribute('href', '/loyalty/signup?next=%2Floyalty%2Fdashboard%2Fqr');
    expect(screen.getByRole('link', { name: /phone number instead/ })).toHaveAttribute('href', '/loyalty/login?method=phone&next=%2Floyalty%2Fdashboard%2Fqr');
  });
});

describe('SignupRequestForm', () => {
  it('shows the same "check your email" confirmation whatever the address', async () => {
    h.request.mockResolvedValue({ sent: true });
    render(<SignupRequestForm next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Name'), 'Synthetic Customer');
    await userEvent.type(screen.getByLabelText('Email'), 'anyone@example.test');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'a long enough password 42');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a long enough password 42');
    await userEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));
    expect(await screen.findByText('Check your email')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });
  it('translates rate limiting and unavailability', async () => {
    h.request.mockResolvedValue({ error: 'rate_limited' });
    render(<SignupRequestForm next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Name'), 'Synthetic Customer');
    await userEvent.type(screen.getByLabelText('Email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'a long enough password 42');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a long enough password 42');
    await userEvent.click(screen.getByRole('button', { name: 'Send confirmation link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Too many attempts.');
  });
});

describe('SignupVerifyForm', () => {
  it('reads the proof from the fragment, removes it from the address bar, and submits it with the password', async () => {
    window.location.hash = `#c=${encodeURIComponent(CHALLENGE)}`;
    const replace = vi.spyOn(window.history, 'replaceState');
    h.complete.mockResolvedValue({ success: true, next: '/loyalty/dashboard' });
    const { container } = render(<SignupVerifyForm next="/loyalty/dashboard" />);
    expect(await screen.findByLabelText('Confirm your email')).toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith(null, '', '/loyalty/signup/verify');
    expect((container.querySelector('input[name="challenge"]') as HTMLInputElement).value).toBe(CHALLENGE);
    await userEvent.type(screen.getByLabelText('Name'), 'Synthetic Customer');
    await userEvent.type(screen.getByLabelText('Confirm your email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'a long enough password 42');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'a long enough password 42');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/loyalty/dashboard'));
  });
  it('an incomplete or tampered link shows a plain message and a way to request a new one, with no form', async () => {
    window.location.hash = '#c=garbage';
    render(<SignupVerifyForm next="/loyalty/dashboard" />);
    expect(await screen.findByText(/This link is incomplete/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose a password')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Request a new link' })).toHaveAttribute('href', '/loyalty/signup?next=%2Floyalty%2Fdashboard');
  });
  it('shows a translated error for a rejected proof', async () => {
    window.location.hash = `#c=${encodeURIComponent(CHALLENGE)}`;
    h.complete.mockResolvedValue({ error: 'invalid_proof' });
    render(<SignupVerifyForm next="/loyalty/dashboard" />);
    await userEvent.type(await screen.findByLabelText('Name'), 'Synthetic Customer');
    await userEvent.type(await screen.findByLabelText('Confirm your email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'x');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/expired or was already used/);
  });
});

describe('entry points', () => {
  it('routes the primary customer sign-in to email/password when enabled and keeps OTP as an explicit alternate', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
    const emailPrimary = await CustomerLoginPage({ searchParams: Promise.resolve({}) }) as { type: unknown };
    const phoneAlternate = await CustomerLoginPage({ searchParams: Promise.resolve({ method: 'phone' }) }) as { type: unknown };
    expect(emailPrimary.type).toBe(EmailLoginForm);
    expect(phoneAlternate.type).toBe(OtpLoginForm);
  });
  it('the phone sign-in page links to email sign-in only when the feature is on', () => {
    const { rerender } = render(<OtpLoginForm next="/loyalty/dashboard" emailEnabled />);
    expect(screen.getByRole('link', { name: 'Sign in with email' })).toHaveAttribute('href', '/loyalty/login?next=%2Floyalty%2Fdashboard');
    rerender(<OtpLoginForm next="/loyalty/dashboard" />);
    expect(screen.queryByRole('link', { name: 'Sign in with email' })).not.toBeInTheDocument();
  });
  it('all three pages are a 404 when the web flag is off, and render when it is on', async () => {
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = '';
    for (const page of [EmailLoginPage, SignupPage, VerifyPage]) {
      await expect(page({ searchParams: Promise.resolve({}) })).rejects.toThrow('NOT_FOUND');
    }
    process.env.CUSTOMER_EMAIL_AUTH_ENABLED = 'true';
    for (const page of [EmailLoginPage, SignupPage, VerifyPage]) {
      await expect(page({ searchParams: Promise.resolve({ next: '//evil.example' }) })).resolves.toBeTruthy();
    }
  });
});

describe('SignupVerifyForm password minimum (configured, approved 8)', () => {
  it('shows the configured minimum as a hint and as the input constraint', async () => {
    window.location.hash = `#c=${encodeURIComponent(CHALLENGE)}`;
    render(<SignupVerifyForm next="/loyalty/dashboard" minLength={8} />);
    const input = await screen.findByLabelText('Choose a password');
    expect(input).toHaveAttribute('minlength', '8');
    expect(screen.getByText('At least 8 characters.')).toBeInTheDocument();
  });
  it('shows no number when none is configured (nothing is assumed on the screen)', async () => {
    window.location.hash = `#c=${encodeURIComponent(CHALLENGE)}`;
    render(<SignupVerifyForm next="/loyalty/dashboard" />);
    const input = await screen.findByLabelText('Choose a password');
    expect(input).not.toHaveAttribute('minlength');
    expect(screen.queryByText(/At least/)).not.toBeInTheDocument();
  });
  it('a too-short password shows a translated error naming the configured minimum', async () => {
    window.location.hash = `#c=${encodeURIComponent(CHALLENGE)}`;
    h.complete.mockResolvedValue({ error: 'password_too_short', minLength: 8 });
    render(<SignupVerifyForm next="/loyalty/dashboard" minLength={8} />);
    await userEvent.type(await screen.findByLabelText('Name'), 'Synthetic Customer');
    await userEvent.type(await screen.findByLabelText('Confirm your email'), 'a@example.test');
    await userEvent.type(screen.getByLabelText('Choose a password'), 'abc');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your password must be at least 8 characters.');
  });
  it('the verify page passes the configured minimum to the screen', async () => {
    process.env.CUSTOMER_PASSWORD_MIN_LENGTH = '8';
    const element = (await VerifyPage({ searchParams: Promise.resolve({}) })) as { props: { minLength?: number } };
    expect(element.props.minLength).toBe(8);
    delete process.env.CUSTOMER_PASSWORD_MIN_LENGTH;
    const without = (await VerifyPage({ searchParams: Promise.resolve({}) })) as { props: { minLength?: number } };
    expect(without.props.minLength).toBeUndefined();
  });
});

