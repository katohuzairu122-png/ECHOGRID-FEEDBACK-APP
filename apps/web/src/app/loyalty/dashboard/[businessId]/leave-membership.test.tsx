import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { leaveLoyaltyAction } from '@/lib/actions/loyalty-customer';
import { LeaveMembership } from './leave-membership';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
vi.mock('@/lib/actions/loyalty-customer', () => ({ leaveLoyaltyAction: vi.fn() }));

const LEAVE_BUTTON = 'Leave loyalty program';
const CONFIRM = 'Yes, leave';
const KEEP = 'Keep my membership';
const ERROR = 'Unable to leave right now. Please try again.';

function renderLeave() {
  return render(<LeaveMembership businessId="business-1" businessName="Acme Café" />);
}

describe('LeaveMembership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('offers only the Leave button at first: nothing is asked or sent until the customer chooses to', () => {
    renderLeave();

    expect(screen.getByRole('button', { name: LEAVE_BUTTON })).toBeEnabled();
    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
    expect(leaveLoyaltyAction).not.toHaveBeenCalled();
  });

  it('says what leaving means, naming the business, before anything is sent', async () => {
    const user = userEvent.setup();
    renderLeave();

    await user.click(screen.getByRole('button', { name: LEAVE_BUTTON }));

    const prompt = screen.getByRole('group', { name: LEAVE_BUTTON });
    expect(prompt).toHaveTextContent("Leave Acme Café's loyalty program?");
    expect(prompt).toHaveTextContent('stop earning and redeeming points');
    expect(prompt).toHaveTextContent('consent to join is withdrawn');
    expect(prompt).toHaveTextContent('Your points are kept and come back if you rejoin');
    expect(leaveLoyaltyAction).not.toHaveBeenCalled();
  });

  it('goes back to the Leave button, sending nothing, when the customer keeps their membership', async () => {
    const user = userEvent.setup();
    renderLeave();
    await user.click(screen.getByRole('button', { name: LEAVE_BUTTON }));

    await user.click(screen.getByRole('button', { name: KEEP }));

    expect(screen.getByRole('button', { name: LEAVE_BUTTON })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: CONFIRM })).not.toBeInTheDocument();
    expect(leaveLoyaltyAction).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('leaves for this business and refreshes the page once the customer confirms', async () => {
    const user = userEvent.setup();
    vi.mocked(leaveLoyaltyAction).mockResolvedValue({ left: true });
    renderLeave();
    await user.click(screen.getByRole('button', { name: LEAVE_BUTTON }));

    await user.click(screen.getByRole('button', { name: CONFIRM }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(leaveLoyaltyAction).toHaveBeenCalledExactlyOnceWith('business-1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the localized failure, does not refresh, and keeps the choice open when the API refuses', async () => {
    const user = userEvent.setup();
    vi.mocked(leaveLoyaltyAction).mockResolvedValue({
      error: 'This membership cannot be left by the customer.',
      code: 'MEMBERSHIP_NOT_LEAVABLE',
    });
    renderLeave();
    await user.click(screen.getByRole('button', { name: LEAVE_BUTTON }));

    await user.click(screen.getByRole('button', { name: CONFIRM }));

    expect(await screen.findByRole('alert')).toHaveTextContent(ERROR);
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: CONFIRM })).toBeEnabled();
  });

  it('shows the same failure when the action itself throws', async () => {
    const user = userEvent.setup();
    vi.mocked(leaveLoyaltyAction).mockRejectedValue(new Error('boom'));
    renderLeave();
    await user.click(screen.getByRole('button', { name: LEAVE_BUTTON }));

    await user.click(screen.getByRole('button', { name: CONFIRM }));

    expect(await screen.findByRole('alert')).toHaveTextContent(ERROR);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('clears the failure and goes through when the customer retries', async () => {
    const user = userEvent.setup();
    vi.mocked(leaveLoyaltyAction)
      .mockResolvedValueOnce({ error: 'Something went wrong. Please try again.' })
      .mockResolvedValueOnce({ left: true });
    renderLeave();
    await user.click(screen.getByRole('button', { name: LEAVE_BUTTON }));
    await user.click(screen.getByRole('button', { name: CONFIRM }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: CONFIRM }));

    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(leaveLoyaltyAction).toHaveBeenCalledTimes(2);
  });
});
