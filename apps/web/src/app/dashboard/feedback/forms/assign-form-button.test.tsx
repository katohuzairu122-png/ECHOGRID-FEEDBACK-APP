import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { assignFeedbackFormAction } from '@/lib/actions/feedback-forms';
import { AssignFormButton } from './assign-form-button';

vi.mock('@/lib/actions/feedback-forms', () => ({
  assignFeedbackFormAction: vi.fn(),
}));

describe('AssignFormButton', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows confirmation after assigning a form', async () => {
    const user = userEvent.setup();
    vi.mocked(assignFeedbackFormAction).mockResolvedValue({
      success: 'Assigned successfully.',
    });

    render(
      <AssignFormButton
        branchId="branch-1"
        versionId="version-1"
        branchName="Main branch"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign to Main branch' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Assigned successfully.');
  });

  it('shows the assignment failure instead of appearing unresponsive', async () => {
    const user = userEvent.setup();
    vi.mocked(assignFeedbackFormAction).mockResolvedValue({
      error: 'You do not have permission to manage feedback forms.',
    });

    render(
      <AssignFormButton
        branchId="branch-1"
        versionId="version-1"
        branchName="Main branch"
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign to Main branch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('permission');
  });
});
