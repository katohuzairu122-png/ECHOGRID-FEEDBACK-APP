import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithIntl } from '@/test-utils';

const m = vi.hoisted(() => ({ email: vi.fn(), managed: vi.fn(), select: vi.fn() }));
vi.mock('@/lib/cashier/actions', () => ({
  cashierLoginAction: m.email, cashierManagedLoginAction: m.managed, cashierSelectAction: m.select,
}));

import { CashierLoginForm } from './cashier-login-form';

beforeEach(() => {
  vi.clearAllMocks();
  m.email.mockResolvedValue({});
  m.managed.mockResolvedValue({});
  m.select.mockResolvedValue({});
});

describe('cashier sign-in form with business-managed accounts', () => {
  it('starts with the staff email form (existing sign-in is unchanged) and can switch to the business code form and back', () => {
    renderWithIntl(<CashierLoginForm />);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.queryByLabelText('Business code')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a business code instead' }));
    expect(screen.getByLabelText('Business code')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with email instead' }));
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });

  it('submits business code, username and password to the managed action only', async () => {
    renderWithIntl(<CashierLoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a business code instead' }));
    fireEvent.change(screen.getByLabelText('Business code'), { target: { value: 'ABCDE-FGHJK' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'till1' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw-pw-pw-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(m.managed).toHaveBeenCalledTimes(1));
    expect(m.email).not.toHaveBeenCalled();
    const sent = m.managed.mock.calls[0]![1] as FormData;
    expect(sent.get('businessCode')).toBe('ABCDE-FGHJK');
    expect(sent.get('username')).toBe('till1');
    expect(sent.get('password')).toBe('pw-pw-pw-pw');
  });

  it('a failed managed sign-in gives one generic message that does not say which part was wrong', async () => {
    m.managed.mockResolvedValue({ error: 'credentials' });
    renderWithIntl(<CashierLoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a business code instead' }));
    for (const [label, value] of [['Business code', 'ABCDEFGHJK'], ['Username', 'x1x'], ['Password', 'wrong-wrong']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That business code, username or password is not correct.');
  });

  it('a multi-branch cashier is asked to pick a branch, and only among the branches the server returned', async () => {
    m.managed.mockResolvedValue({ choices: [{ businessId: 'biz-1', businessName: 'Acme', wideAccess: false, branches: [{ id: 'b1', name: 'Main' }, { id: 'b3', name: 'Airport' }] }] });
    renderWithIntl(<CashierLoginForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with a business code instead' }));
    for (const [label, value] of [['Business code', 'ABCDEFGHJK'], ['Username', 'roam1'], ['Password', 'good-good-1']] as const) {
      fireEvent.change(screen.getByLabelText(label), { target: { value } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Where are you serving?')).toBeInTheDocument();
    const options = screen.getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Main', 'Airport']));
    expect(options).not.toContain('Harbour');
    expect(options).not.toContain('All branches');
  });
});
