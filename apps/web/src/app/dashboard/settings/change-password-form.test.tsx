import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl } from '@/test-utils';
import { ChangePasswordForm } from './change-password-form';
import { changePasswordAction } from '@/lib/actions/auth';

vi.mock('@/lib/actions/auth', () => ({
  changePasswordAction: vi.fn(),
}));

describe('ChangePasswordForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits the current password and new password fields through the action', async () => {
    const user = userEvent.setup();
    vi.mocked(changePasswordAction).mockResolvedValue({});

    renderWithIntl(<ChangePasswordForm />);

    await user.type(screen.getByLabelText('Current password'), 'current-password');
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(changePasswordAction).toHaveBeenCalled();
  });

  it('uses the correct browser password semantics and validation floors', () => {
    renderWithIntl(<ChangePasswordForm />);

    const currentPassword = screen.getByLabelText('Current password');
    const newPassword = screen.getByLabelText('New password');
    const confirmPassword = screen.getByLabelText('Confirm new password');

    expect(currentPassword).toBeRequired();
    expect(currentPassword).toHaveAttribute('autocomplete', 'current-password');
    expect(currentPassword).not.toHaveAttribute('minLength');

    expect(newPassword).toBeRequired();
    expect(newPassword).toHaveAttribute('autocomplete', 'new-password');
    expect(newPassword).toHaveAttribute('minLength', '12');

    expect(confirmPassword).toBeRequired();
    expect(confirmPassword).toHaveAttribute('autocomplete', 'new-password');
    expect(confirmPassword).toHaveAttribute('minLength', '12');
  });

  it('surfaces an action error without replacing the form', async () => {
    const user = userEvent.setup();
    vi.mocked(changePasswordAction).mockResolvedValue({
      error: 'Current password is incorrect.',
    });

    renderWithIntl(<ChangePasswordForm />);

    await user.type(screen.getByLabelText('Current password'), 'wrong-password');
    await user.type(screen.getByLabelText('New password'), 'a-brand-new-password');
    await user.type(screen.getByLabelText('Confirm new password'), 'a-brand-new-password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Current password is incorrect.',
    );
    expect(screen.getByLabelText('Current password')).toBeInTheDocument();
  });
});
