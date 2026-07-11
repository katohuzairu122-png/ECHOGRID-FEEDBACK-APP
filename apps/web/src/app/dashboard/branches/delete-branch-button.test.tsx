import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { DeleteBranchButton } from './delete-branch-button';
import { deleteBranchAction } from '@/lib/actions/branches';

vi.mock('@/lib/actions/branches', () => ({
  deleteBranchAction: vi.fn(),
}));

describe('DeleteBranchButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing if the confirm prompt is dismissed', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithIntl(<DeleteBranchButton branchId="branch-1" branchName="Downtown" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(deleteBranchAction).not.toHaveBeenCalled();
  });

  it('calls deleteBranchAction with the branch id when the confirm prompt is accepted', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(deleteBranchAction).mockResolvedValue(undefined);

    renderWithIntl(<DeleteBranchButton branchId="branch-1" branchName="Downtown" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(deleteBranchAction).toHaveBeenCalledWith('branch-1'));
  });

  it('surfaces a failed delete with an alert instead of failing silently', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    vi.mocked(deleteBranchAction).mockRejectedValue(new Error('network error'));

    renderWithIntl(<DeleteBranchButton branchId="branch-1" branchName="Downtown" />);
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(alertSpy).toHaveBeenCalled());
  });
});
