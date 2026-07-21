import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { DeleteTierButton } from './delete-tier-button';
import { deleteTierAction } from '@/lib/actions/loyalty';

vi.mock('@/lib/actions/loyalty', () => ({
  deleteTierAction: vi.fn(),
}));

describe('DeleteTierButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing if the confirm prompt is dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<DeleteTierButton tierId="tier-1" tierName="Gold" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteTierAction).not.toHaveBeenCalled();
  });

  it('calls deleteTierAction with the tier id when the confirm prompt is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteTierAction).mockResolvedValue(undefined);

    render(<DeleteTierButton tierId="tier-1" tierName="Gold" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteTierAction).toHaveBeenCalledWith('tier-1'));
  });

  it('includes the tier name in the confirm prompt so staff know exactly what they are deleting', async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<DeleteTierButton tierId="tier-1" tierName="Gold" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(confirmSpy.mock.calls[0]![0]).toContain('Gold');
  });

  it('surfaces a failed delete with an alert instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(deleteTierAction).mockRejectedValue(new Error('network error'));

    render(<DeleteTierButton tierId="tier-1" tierName="Gold" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  });
});
