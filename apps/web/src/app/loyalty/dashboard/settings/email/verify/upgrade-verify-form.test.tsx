import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithIntl as render } from '@/test-utils';

const h = vi.hoisted(() => ({ complete: vi.fn(async () => ({})) }));
vi.mock('@/lib/actions/customer-email-upgrade', () => ({ completeCustomerEmailUpgradeAction: h.complete }));
import { CustomerEmailUpgradeVerifyForm } from './upgrade-verify-form';

const proof = '141664f8-1ef4-4872-b445-fca151ba65aa.' + 'a'.repeat(64);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { window.history.replaceState(null, '', '/'); vi.restoreAllMocks(); });

describe('legacy email-upgrade proof landing', () => {
  it('retains the one-time fragment through Strict Mode effect replay while scrubbing browser history', () => {
    window.history.replaceState(null, '', '/loyalty/dashboard/settings/email/verify#c=' + encodeURIComponent(proof));
    const scrub = vi.spyOn(window.history, 'replaceState');
    const view = render(<StrictMode><CustomerEmailUpgradeVerifyForm /></StrictMode>);
    expect(screen.getByLabelText('Name')).toBeRequired();
    expect(screen.getByLabelText('Email to link')).toBeRequired();
    expect(view.container.querySelector('input[name="challenge"]')).toHaveValue(proof);
    expect(window.location.hash).toBe('');
    expect(scrub).toHaveBeenCalledOnce();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each(['', '#c=forged', '#c=' + encodeURIComponent(proof) + '&unexpected=1'])(
    'rejects missing or malformed proof %s without exposing the credential form', (fragment) => {
      window.history.replaceState(null, '', '/loyalty/dashboard/settings/email/verify' + fragment);
      render(<StrictMode><CustomerEmailUpgradeVerifyForm /></StrictMode>);
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(window.location.hash).toBe('');
      expect(h.complete).not.toHaveBeenCalled();
    },
  );
});
