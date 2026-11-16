import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

const h = vi.hoisted(() => ({ request: vi.fn(), verify: vi.fn() }));
vi.mock('@/lib/actions/customer-phone', () => ({ requestPhoneCodeAction: h.request, verifyPhoneCodeAction: h.verify }));
vi.mock('@/lib/actions/language', () => ({ setLanguageAction: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { PhoneVerifyForm } from './phone-verify-form';

const assign = vi.fn();
const unverified = { phoneMasked: null, verified: false };
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'location', { value: { ...window.location, assign }, writable: true });
});
afterEach(() => vi.restoreAllMocks());

describe('PhoneVerifyForm', () => {
  it('starts with the number step, and shows only a MASKED number on file', () => {
    render(<PhoneVerifyForm status={{ phoneMasked: '+•••••••4591', verified: false }} next="/loyalty/dashboard" />);
    expect(screen.getByLabelText('Phone number')).toBeInTheDocument();
    expect(screen.getByText(/Number on file, not verified yet: \+•••••••4591/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });
  it('moves to the code step after a code is sent, carrying the number forward', async () => {
    h.request.mockResolvedValue({ sent: true, phone: '+96566904591' });
    render(<PhoneVerifyForm status={unverified} next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Phone number'), '+96566904591');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByLabelText('Verification code')).toBeInTheDocument();
    expect(screen.getByText(/We sent a code to \+96566904591/)).toBeInTheDocument();
  });
  it('translates a request error and stays on the number step', async () => {
    h.request.mockResolvedValue({ error: 'taken' });
    render(<PhoneVerifyForm status={unverified} next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Phone number'), '+96566904591');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already verified on another account');
    expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });
  it('a wrong code shows a translated error and keeps the code step open', async () => {
    h.request.mockResolvedValue({ sent: true, phone: '+96566904591' });
    h.verify.mockResolvedValue({ error: 'invalid_code', sent: true, phone: '+96566904591' });
    render(<PhoneVerifyForm status={unverified} next="/loyalty/dashboard" />);
    await userEvent.type(screen.getByLabelText('Phone number'), '+96566904591');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText('Verification code'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Verify phone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That code is not correct or has expired.');
    expect(screen.getByLabelText('Verification code')).toBeInTheDocument();
  });
  it('a verified number shows the confirmation and goes on to where the customer was headed', async () => {
    h.request.mockResolvedValue({ sent: true, phone: '+96566904591' });
    h.verify.mockResolvedValue({ verified: true, next: '/loyalty/qr-token?autocheckin=1' });
    render(<PhoneVerifyForm status={unverified} next="/loyalty/qr-token?autocheckin=1" />);
    await userEvent.type(screen.getByLabelText('Phone number'), '+96566904591');
    await userEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await userEvent.type(await screen.findByLabelText('Verification code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify phone' }));
    expect(await screen.findByText('Your phone is verified')).toBeInTheDocument();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/loyalty/qr-token?autocheckin=1'));
  });
  it('an already verified customer sees the confirmation and no form', () => {
    render(<PhoneVerifyForm status={{ phoneMasked: '+•••••••4591', verified: true }} next="/loyalty/dashboard" />);
    expect(screen.getByText('Your phone is verified')).toBeInTheDocument();
    expect(screen.queryByLabelText('Phone number')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/loyalty/dashboard');
  });
});
