import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { RewardRowActions } from './reward-row-actions';
import { toggleRewardStatusAction, deleteRewardAction } from '@/lib/actions/loyalty';

vi.mock('@/lib/actions/loyalty', () => ({
  toggleRewardStatusAction: vi.fn(),
  deleteRewardAction: vi.fn(),
}));

describe('RewardRowActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Deactivate" for an active reward and toggles it to inactive with no confirm prompt', async () => {
    const user = userEvent.setup();
    vi.mocked(toggleRewardStatusAction).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm');

    render(<RewardRowActions rewardId="reward-1" status="active" />);
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deactivate' }));

    await waitFor(() => expect(toggleRewardStatusAction).toHaveBeenCalledWith('reward-1', 'inactive'));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('shows "Activate" for an inactive reward and toggles it back to active', async () => {
    const user = userEvent.setup();
    vi.mocked(toggleRewardStatusAction).mockResolvedValue(undefined);

    render(<RewardRowActions rewardId="reward-1" status="inactive" />);
    await user.click(screen.getByRole('button', { name: 'Activate' }));

    await waitFor(() => expect(toggleRewardStatusAction).toHaveBeenCalledWith('reward-1', 'active'));
  });

  it('does nothing if the delete confirm prompt is dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<RewardRowActions rewardId="reward-1" status="active" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteRewardAction).not.toHaveBeenCalled();
  });

  it('calls deleteRewardAction when the delete confirm prompt is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteRewardAction).mockResolvedValue(undefined);

    render(<RewardRowActions rewardId="reward-1" status="active" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteRewardAction).toHaveBeenCalledWith('reward-1'));
  });

  it('surfaces a failed delete with an alert instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(deleteRewardAction).mockRejectedValue(new Error('network error'));

    render(<RewardRowActions rewardId="reward-1" status="active" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  });
});
