import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';

const h = vi.hoisted(() => ({
  start: vi.fn(),
  requestEmail: vi.fn(),
  verifyEmail: vi.fn(),
  requestPhone: vi.fn(),
  verifyPhone: vi.fn(),
  verifyCode: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('@/lib/actions/customer-recovery', () => ({
  startCustomerRecoveryAction: h.start,
  requestRecoveryEmailAction: h.requestEmail,
  verifyRecoveryEmailAction: h.verifyEmail,
  requestRecoveryPhoneAction: h.requestPhone,
  verifyRecoveryPhoneAction: h.verifyPhone,
  verifyRecoveryCodeAction: h.verifyCode,
  completeCustomerRecoveryAction: h.complete,
  cancelCustomerRecoveryAction: h.cancel,
}));

import { CustomerRecoveryStartForm, RecoveryEmailLanding } from './recovery-form';

const ATTEMPT = 'a114c838-35fb-4ce4-899f-5e3c644027f5';
const CHALLENGE = 'b114c838-35fb-4ce4-899f-5e3c644027f5';
const PROOF = 'a'.repeat(64);

beforeEach(() => {
  vi.clearAllMocks();
  h.start.mockImplementation(async () => ({ started: true, attemptId: ATTEMPT }));
  h.verifyEmail.mockResolvedValue({ status: 'awaiting_factors' });
});
afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('customer account recovery journey', () => {
  it('starts with an accessible email form and moves into factor verification without putting account data in the URL', async () => {
    render(<CustomerRecoveryStartForm />);
    expect(screen.getByLabelText('Account email')).toBeRequired();
    await userEvent.type(screen.getByLabelText('Account email'), 'customer@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Email confirmation' })).toBeInTheDocument();
    expect(screen.getByText(/verify two different factors/i)).toBeInTheDocument();
    expect(window.location.search).toBe('');
  });

  it('supports verified-phone initiation for the approved lost-email recovery path', async () => {
    render(<CustomerRecoveryStartForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Verified phone' }));
    expect(screen.getByLabelText('Verified phone number')).toBeRequired();
    expect(screen.queryByLabelText('Account email')).not.toBeInTheDocument();
  });

  it('scrubs the recovery proof fragment and submits the attempt-bound email factor', async () => {
    window.history.replaceState(
      null,
      '',
      `/account/recovery/email#c=${encodeURIComponent(`${ATTEMPT}.${CHALLENGE}.${PROOF}`)}`,
    );
    render(<RecoveryEmailLanding />);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm this email factor' }));
    expect(h.verifyEmail).toHaveBeenCalledWith(expect.anything(), expect.any(FormData));
    expect(window.location.hash).toBe('');
    expect(
      await screen.findByText(
        'One more independent factor is required before a password can be reset.',
      ),
    ).toBeInTheDocument();
  });
});
