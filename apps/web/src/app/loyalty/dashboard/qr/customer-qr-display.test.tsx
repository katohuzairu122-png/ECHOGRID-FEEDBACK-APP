import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), revoke: vi.fn() }));
vi.mock('@/lib/actions/loyalty-customer', () => ({
  refreshCustomerQrAction: mocks.refresh,
  revokeCustomerQrAction: mocks.revoke,
}));
vi.mock('react-qr-code', () => ({ default: ({ value }: { value: string }) => <div data-testid="qr">{value}</div> }));

import { CustomerQrDisplay } from './customer-qr-display';

const inHours = (h: number) => new Date(Date.now() + h * 3600 * 1000).toISOString();

describe('CustomerQrDisplay', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the QR for a fresh 24h credential without renewing it', () => {
    render(<CustomerQrDisplay token="tok-1" expiresAt={inHours(24)} />);
    expect(screen.getByTestId('qr')).toHaveTextContent('tok-1');
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('renews immediately when the credential is already inside the renewal window', async () => {
    mocks.refresh.mockResolvedValue({ token: 'tok-new', expiresAt: inHours(24) });
    render(<CustomerQrDisplay token="tok-old" expiresAt={inHours(0.2)} />);
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('tok-new'));
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('replace-QR revokes server-side and shows the new code', async () => {
    mocks.revoke.mockResolvedValue({ token: 'tok-revoked-new', expiresAt: inHours(24) });
    render(<CustomerQrDisplay token="tok-1" expiresAt={inHours(24)} />);
    await userEvent.click(screen.getByRole('button', { name: /replace qr/i }));
    await waitFor(() => expect(screen.getByTestId('qr')).toHaveTextContent('tok-revoked-new'));
    expect(mocks.revoke).toHaveBeenCalledTimes(1);
  });

  it('reports a renewal failure without losing the still-valid code', async () => {
    mocks.refresh.mockRejectedValue(new Error('offline'));
    render(<CustomerQrDisplay token="tok-1" expiresAt={inHours(24)} />);
    await userEvent.click(screen.getByRole('button', { name: /renew qr/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not renew/i);
    expect(screen.getByTestId('qr')).toHaveTextContent('tok-1');
  });
});
