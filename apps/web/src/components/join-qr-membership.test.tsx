import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { joinLoyaltyAction } from '@/lib/actions/loyalty-customer';
import { JoinQrMembership } from './join-qr-membership';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/actions/loyalty-customer', () => ({ joinLoyaltyAction: vi.fn() }));

describe('JoinQrMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the consent wording and keeps Join disabled until it is ticked', async () => {
    const user = userEvent.setup();
    render(<JoinQrMembership token="qr-token" />);

    const consent = screen.getByRole('checkbox', {
      name: /I agree to join this business's loyalty program and let it record my visits, purchases and points/,
    });
    const join = screen.getByRole('button', { name: 'Join loyalty' });
    expect(consent).not.toBeChecked();
    expect(join).toBeDisabled();

    await user.click(join);
    expect(joinLoyaltyAction).not.toHaveBeenCalled();

    await user.click(consent);
    expect(join).toBeEnabled();
  });

  it('joins with the explicit acceptance and refreshes the page', async () => {
    const user = userEvent.setup();
    vi.mocked(joinLoyaltyAction).mockResolvedValue({} as never);
    render(<JoinQrMembership token="qr-token" />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Join loyalty' }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(joinLoyaltyAction).toHaveBeenCalledWith('qr-token', true);
  });

  it('shows the localized failure message and does not refresh when joining fails', async () => {
    const user = userEvent.setup();
    vi.mocked(joinLoyaltyAction).mockRejectedValue(new Error('boom'));
    render(<JoinQrMembership token="qr-token" />);

    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Join loyalty' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to join. Sign in again or retry this QR.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
