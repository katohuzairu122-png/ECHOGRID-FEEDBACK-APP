import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import { acceptInvitationAction } from '@/lib/actions/team';
import { AcceptInvitationForm } from './accept-invitation-form';

vi.mock('@/lib/actions/team', () => ({
  acceptInvitationAction: vi.fn(),
}));

describe('AcceptInvitationForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an API acceptance error without replacing the page with Retry', async () => {
    const user = userEvent.setup();
    vi.mocked(acceptInvitationAction).mockResolvedValue({
      error: 'Sign in with the invited email address.',
    });

    render(<AcceptInvitationForm token="invitation-token" />);
    await user.click(screen.getByRole('button', { name: 'Accept invitation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign in with the invited email address.',
    );
    expect(acceptInvitationAction).toHaveBeenCalled();
  });
});
