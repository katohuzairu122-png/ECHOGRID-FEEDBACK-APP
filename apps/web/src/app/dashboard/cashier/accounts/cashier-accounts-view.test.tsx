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
const view = (accounts: CashierAccountDto[], code: string | null = 'ABCDEFGHJK', branchList = branches) =>
  renderWithIntl(<CashierAccountsView accounts={accounts} code={{ cashierCode: code, rotatedAt: null }} branches={branchList} />);

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

  const nameBox = () => screen.getByLabelText("Cashier's name");
  const createdCredential = { username: 'amina', password: 'Gen3ratedPass1234567890', cashierCode: 'ABCDEFGHJK' };

  it('simplest case, one branch: only a name is asked; the branch is shown as text; the password is asked for in a dialog right there', async () => {
    m.reauth.mockResolvedValue({ status: 'reauthenticated' });
    m.create.mockResolvedValue({ status: 'created', credential: createdCredential });
    view([], 'ABCDEFGHJK', [{ id: 'b1', name: 'Buddy 1' }]);
    expect(screen.getByText('Works at Buddy 1')).toBeInTheDocument();
    expect(screen.queryByLabelText('Several branches')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Buddy 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Username/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Password/)).not.toBeInTheDocument();
    fireEvent.change(nameBox(), { target: { value: 'Amina' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    expect(m.reauth).not.toHaveBeenCalled(); // nothing happens until the owner confirms in the dialog
    fireEvent.change(await screen.findByLabelText('Password to confirm'), { target: { value: 'owner-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    expect(await screen.findByText('Save this sign-in now')).toBeInTheDocument();
    expect((m.reauth.mock.calls[0]![1] as FormData).get('password')).toBe('owner-password');
    const sent = m.create.mock.calls[0]![1] as FormData;
    expect(sent.get('username')).toBe('amina');
    expect(sent.get('displayName')).toBe('Amina');
    expect(sent.get('accessMode')).toBe('single');
    expect(sent.getAll('branchId')).toEqual(['b1']);
    expect(sent.get('password')).toBeNull(); // always generated
    expect(screen.getByText('Gen3ratedPass1234567890')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    await waitFor(() => expect(screen.queryByText('Gen3ratedPass1234567890')).not.toBeInTheDocument());
    expect(screen.getByText('The cashier was created.')).toBeInTheDocument();
    expect((nameBox() as HTMLInputElement).value).toBe('');
  });

  it('several branches: all are ticked by default; unticking leaves the rest, and one left means single access', async () => {
    m.reauth.mockResolvedValue({ status: 'reauthenticated' });
    m.create.mockResolvedValue({ status: 'created', credential: createdCredential });
    view([]);
    const create = screen.getByRole('heading', { name: 'Add a cashier' }).closest('section')!;
    for (const b of ['Main', 'Harbour', 'Airport']) expect(within(create).getByLabelText(b)).toBeChecked();
    fireEvent.click(within(create).getByLabelText('Harbour'));
    fireEvent.click(within(create).getByLabelText('Airport'));
    fireEvent.change(nameBox(), { target: { value: 'Roaming Rita' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    fireEvent.change(await screen.findByLabelText('Password to confirm'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    await screen.findByText('Save this sign-in now');
    const sent = m.create.mock.calls[0]![1] as FormData;
    expect(sent.getAll('branchId')).toEqual(['b1']);
    expect(sent.get('accessMode')).toBe('single');
    expect(sent.get('username')).toBe('roaming.rita');
  });

  it('asks for the name and at least one branch before anything else happens', () => {
    view([]);
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    expect(screen.getByText("Type the cashier's name.")).toBeInTheDocument();
    expect(screen.queryByLabelText('Password to confirm')).not.toBeInTheDocument();
    const create = screen.getByRole('heading', { name: 'Add a cashier' }).closest('section')!;
    for (const b of ['Main', 'Harbour', 'Airport']) fireEvent.click(within(create).getByLabelText(b));
    fireEvent.change(nameBox(), { target: { value: 'Amina' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    expect(screen.getByText('Tick at least one branch.')).toBeInTheDocument();
    expect(m.reauth).not.toHaveBeenCalled();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a wrong owner password is explained inside the dialog and nothing is created', async () => {
    m.reauth.mockResolvedValue({ status: 'failed', error: 'UNAUTHENTICATED' });
    view([], 'ABCDEFGHJK', [{ id: 'b1', name: 'Buddy 1' }]);
    fireEvent.change(nameBox(), { target: { value: 'Amina' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    fireEvent.change(await screen.findByLabelText('Password to confirm'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    expect(await screen.findByText('That password is not correct.')).toBeInTheDocument();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a taken sign-in name is retried with digits added, without bothering the owner', async () => {
    m.reauth.mockResolvedValue({ status: 'reauthenticated' });
    m.create
      .mockResolvedValueOnce({ status: 'failed', error: 'CASHIER_USERNAME_TAKEN' })
      .mockResolvedValueOnce({ status: 'created', credential: { ...createdCredential, username: 'amina47' } });
    view([], 'ABCDEFGHJK', [{ id: 'b1', name: 'Buddy 1' }]);
    fireEvent.change(nameBox(), { target: { value: 'Amina' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    fireEvent.change(await screen.findByLabelText('Password to confirm'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    expect(await screen.findByText('Save this sign-in now')).toBeInTheDocument();
    expect(m.create).toHaveBeenCalledTimes(2);
    expect((m.create.mock.calls[0]![1] as FormData).get('username')).toBe('amina');
    expect((m.create.mock.calls[1]![1] as FormData).get('username')).toMatch(/^amina\d{2}$/);
  });

  it('other failures get plain messages in the dialog; an unknown one gets a generic message, never raw text', async () => {
    m.reauth.mockResolvedValue({ status: 'reauthenticated' });
    m.create.mockResolvedValue({ status: 'failed', error: 'SOMETHING_SECRET_INTERNAL' });
    view([], 'ABCDEFGHJK', [{ id: 'b1', name: 'Buddy 1' }]);
    fireEvent.change(nameBox(), { target: { value: 'Amina' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    fireEvent.change(await screen.findByLabelText('Password to confirm'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    expect(await screen.findByText('That could not be done. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/SECRET_INTERNAL/)).not.toBeInTheDocument();
  });

  it('with no branch yet it says to create one first and does not offer the button', () => {
    view([], 'ABCDEFGHJK', []);
    expect(screen.getByText('Create a branch first, then you can add a cashier.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create cashier' })).toBeDisabled();
  });

  it('the sign-in details can be copied in one tap', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    m.reauth.mockResolvedValue({ status: 'reauthenticated' });
    m.create.mockResolvedValue({ status: 'created', credential: createdCredential });
    view([], 'ABCDEFGHJK', [{ id: 'b1', name: 'Buddy 1' }]);
    fireEvent.change(nameBox(), { target: { value: 'Amina' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create cashier' }));
    fireEvent.change(await screen.findByLabelText('Password to confirm'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and create' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy sign-in details' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain('Gen3ratedPass1234567890');
    expect(writeText.mock.calls[0]![0]).toContain('amina');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('editing still offers one or several branches only when the business has two or more', async () => {
    view([account({ accessMode: 'multiple', branches: [{ id: 'b1', name: 'Main' }, { id: 'b2', name: 'Harbour' }] })]);
    fireEvent.click(screen.getByRole('button', { name: 'Branches' }));
    const row = screen.getByText('Front till').closest('li')!;
    fireEvent.click(within(row).getByLabelText('One branch'));
    expect(within(row).getByLabelText('Main')).toBeChecked();
    expect(within(row).getByLabelText('Harbour')).not.toBeChecked();
    fireEvent.click(within(row).getByLabelText('Main'));
    expect(within(row).getByText('Tick exactly one branch.')).toBeInTheDocument();
    fireEvent.click(within(row).getByLabelText('Several branches'));
    fireEvent.click(within(row).getByLabelText('Airport'));
    expect(within(row).getByText('Tick at least two branches.')).toBeInTheDocument();
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
