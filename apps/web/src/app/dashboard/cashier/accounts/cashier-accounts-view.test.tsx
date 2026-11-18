import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';

const m = vi.hoisted(() => ({
  create: vi.fn(), reauth: vi.fn(), reset: vi.fn(), status: vi.fn(), branches: vi.fn(), rotate: vi.fn(),
}));
vi.mock('@/lib/actions/cashier-accounts', () => ({
  createCashierAccountAction: m.create, cashierReauthAction: m.reauth, resetCashierCredentialAction: m.reset,
  cashierAccountStatusAction: m.status, setCashierBranchesAction: m.branches, rotateCashierCodeAction: m.rotate,
}));

import { CashierAccountsView } from './cashier-accounts-view';
import type { CashierAccountDto } from '@/lib/cashier-accounts-types';

const branches = [{ id: 'b1', name: 'Main' }, { id: 'b2', name: 'Harbour' }, { id: 'b3', name: 'Airport' }];
const account = (over: Partial<CashierAccountDto>): CashierAccountDto => ({
  id: 'a1', username: 'till1', displayName: 'Front till', status: 'active', branches: [{ id: 'b1', name: 'Main' }], accessMode: 'single',
  lastLoginAt: null, locked: false, credentialChangedAt: null, createdAt: '2026-11-18T00:00:00Z', ...over,
});
const view = (accounts: CashierAccountDto[], code: string | null = 'ABCDEFGHJK') =>
  renderWithIntl(<CashierAccountsView accounts={accounts} code={{ cashierCode: code, rotatedAt: null }} branches={branches} />);

beforeEach(() => {
  // mockReset (not clear): a queued mockResolvedValueOnce must never leak into the next test.
  for (const fn of Object.values(m)) fn.mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

describe('cashier accounts view', () => {
  it('lists each cashier with status, branches and mode, and shows the business code', () => {
    view([
      account({}),
      account({ id: 'a2', username: 'multi1', displayName: 'Roaming', accessMode: 'multiple', status: 'disabled', locked: true,
        branches: [{ id: 'b1', name: 'Main' }, { id: 'b3', name: 'Airport' }] }),
    ]);
    expect(screen.getByTestId('business-code')).toHaveTextContent('ABCDEFGHJK');
    expect(screen.getByText('Front till')).toBeInTheDocument();
    expect(screen.getByText(/Branches: Main, Airport/)).toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('Temporarily locked')).toBeInTheDocument();
  });

  it('shows an explicit empty state and a placeholder before any code exists (and no rotate control)', () => {
    view([], null);
    expect(screen.getByText('No cashier accounts yet.')).toBeInTheDocument();
    expect(screen.getByTestId('business-code')).toHaveTextContent('Created with your first cashier account.');
    expect(screen.queryByRole('button', { name: 'Change business code' })).not.toBeInTheDocument();
  });

  it('a revoked account offers no management control at all', () => {
    view([account({ status: 'revoked' })]);
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    for (const name of ['Branches', 'Reset password', 'Disable', 'Enable', 'Sign out devices', 'Revoke access']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('an active account offers disable (not enable); a disabled one offers enable (not disable)', () => {
    view([account({ id: 'a1' }), account({ id: 'a2', username: 'off1', status: 'disabled' })]);
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Enable' })).toHaveLength(1);
  });

  it('single access allows exactly one branch: switching mode trims the selection and a hint explains the rule', () => {
    view([]);
    const create = screen.getByRole('heading', { name: 'Create a cashier account' }).closest('section')!;
    fireEvent.click(within(create).getByLabelText('Several branches'));
    fireEvent.click(within(create).getByLabelText('Main'));
    fireEvent.click(within(create).getByLabelText('Harbour'));
    expect(within(create).getByLabelText('Main')).toBeChecked();
    expect(within(create).getByLabelText('Harbour')).toBeChecked();
    fireEvent.click(within(create).getByLabelText('One branch'));
    expect(within(create).getByLabelText('Main')).toBeChecked();
    expect(within(create).getByLabelText('Harbour')).not.toBeChecked();
    fireEvent.click(within(create).getByLabelText('Main')); // untick: nothing selected
    expect(within(create).getByText('Tick exactly one branch.')).toBeInTheDocument();
    fireEvent.click(within(create).getByLabelText('Several branches'));
    fireEvent.click(within(create).getByLabelText('Airport'));
    expect(within(create).getByText('Tick at least two branches.')).toBeInTheDocument();
  });

  it('creating shows the one-time credential, then dismissing removes it from the page', async () => {
    m.create.mockResolvedValue({ status: 'created', credential: { username: 'till9', password: 'Gen3ratedPass1234567890', cashierCode: 'ABCDEFGHJK' } });
    view([]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'till9' } });
    fireEvent.change(screen.getByLabelText('Name or employee label'), { target: { value: 'Till nine' } });
    fireEvent.click(screen.getByLabelText('Main'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Save this sign-in now')).toBeInTheDocument();
    expect(screen.getByText('Gen3ratedPass1234567890')).toBeInTheDocument();
    expect(m.create).toHaveBeenCalledTimes(1);
    const sent = m.create.mock.calls[0]![1] as FormData;
    expect(sent.get('accessMode')).toBe('single');
    expect(sent.getAll('branchId')).toEqual(['b1']);
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByText('Gen3ratedPass1234567890')).not.toBeInTheDocument();
  });

  it('a password the administrator chose is never shown back', async () => {
    m.create.mockResolvedValue({ status: 'created', credential: { username: 'till8', password: '', cashierCode: 'ABCDEFGHJK' } });
    view([]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'till8' } });
    fireEvent.change(screen.getByLabelText('Name or employee label'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Main'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('The password you chose')).toBeInTheDocument();
  });

  it('known API failures get plain-language messages; an unknown one gets a generic message, never raw text', async () => {
    m.create.mockResolvedValueOnce({ status: 'failed', error: 'CASHIER_USERNAME_TAKEN' });
    view([]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'dup' } });
    fireEvent.change(screen.getByLabelText('Name or employee label'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Main'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('That username is already used in this business.')).toBeInTheDocument();
    m.create.mockResolvedValueOnce({ status: 'failed', error: 'SOMETHING_SECRET_INTERNAL' });
    // React resets the uncontrolled form after an action, so the required fields are filled in again.
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'dup2' } });
    fireEvent.change(screen.getByLabelText('Name or employee label'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Main'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('That could not be done. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_INTERNAL/)).not.toBeInTheDocument();
  });

  it('asks for the password again when the API demands re-authentication', async () => {
    m.create.mockResolvedValue({ status: 'reauthRequired' });
    view([]);
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'till7' } });
    fireEvent.change(screen.getByLabelText('Name or employee label'), { target: { value: 'x' } });
    fireEvent.click(screen.getByLabelText('Main'));
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Confirm your password above, then try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('editing branches pre-selects the current assignment and warns that removal ends sessions on that branch', async () => {
    m.branches.mockResolvedValue({ status: 'updated' });
    view([account({ accessMode: 'multiple', branches: [{ id: 'b1', name: 'Main' }, { id: 'b2', name: 'Harbour' }] })]);
    fireEvent.click(screen.getByRole('button', { name: 'Branches' }));
    const row = screen.getByText('Front till').closest('li')!;
    expect(within(row).getByLabelText('Main')).toBeChecked();
    expect(within(row).getByLabelText('Harbour')).toBeChecked();
    expect(within(row).getByLabelText('Airport')).not.toBeChecked();
    expect(within(row).getByText(/signs out the cashier's sessions on that branch straight away/)).toBeInTheDocument();
    fireEvent.click(within(row).getByLabelText('Airport'));
    fireEvent.click(within(row).getByRole('button', { name: 'Save branches' }));
    await waitFor(() => expect(m.branches).toHaveBeenCalled());
    const sent = m.branches.mock.calls[0]![1] as FormData;
    expect(sent.get('accountId')).toBe('a1');
    expect(sent.get('accessMode')).toBe('multiple');
    expect(sent.getAll('branchId').sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('destructive actions ask for confirmation and do nothing when it is declined', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    view([account({})]);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke access' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(window.confirm).toHaveBeenCalledTimes(3);
    expect(m.status).not.toHaveBeenCalled();
    expect(m.reset).not.toHaveBeenCalled();
  });

  it('a reset shows the new password once', async () => {
    m.reset.mockResolvedValue({ status: 'credentialReset', credential: { username: 'till1', password: 'ResetPass1234567890abc' } });
    view([account({})]);
    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    expect(await screen.findByText('ResetPass1234567890abc')).toBeInTheDocument();
  });
});
