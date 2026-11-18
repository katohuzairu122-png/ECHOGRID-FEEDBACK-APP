import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const m = vi.hoisted(() => ({ list: vi.fn(), swap: vi.fn() }));
vi.mock('@/lib/cashier/actions', () => ({ cashierListBranchesAction: m.list, cashierSwitchBranchAction: m.swap }));

import { BranchSwitcher, type BranchSwitcherCopy } from './branch-switcher';

const copy: BranchSwitcherCopy = {
  button: 'Switch branch', title: 'Switch branch dialog', hint: 'Choose where you serve.', current: 'Current', groupLabel: 'Branches',
  confirm: 'Switch to this branch', switching: 'Switching…', loading: 'Loading branches…', loadFailed: 'Could not load.', retry: 'Try again',
  success: 'Now serving at {branch}.', noChange: 'Already serving at {branch}.', denied: 'No longer allowed.', conflict: 'Changed elsewhere.',
  unavailable: 'Not available now.', close: 'Close',
};
const list = (ids: [string, string][], current = 'b1') => ({ status: 'ready', branches: ids.map(([id, name]) => ({ id, name })), currentBranchId: current });
const open = async () => {
  render(<BranchSwitcher currentBranchId="b1" currentBranchName="Main" copy={copy} />);
  fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
  await screen.findByRole('dialog');
};

beforeEach(() => {
  vi.clearAllMocks();
  m.list.mockResolvedValue(list([['b1', 'Main'], ['b2', 'Harbour'], ['b3', 'Airport']]));
  m.swap.mockResolvedValue({ status: 'switched', branchName: 'Harbour' });
});

describe('branch switcher (multi-branch managed cashier)', () => {
  it('is closed until asked, then loads the branches the SERVER lists, marking the current one', async () => {
    render(<BranchSwitcher currentBranchId="b1" currentBranchName="Main" copy={copy} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(m.list).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByLabelText(/Harbour/)).toBeInTheDocument();
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(within(dialog).getAllByRole('radio').map((r) => (r as HTMLInputElement).value).sort()).toEqual(['b1', 'b2', 'b3']);
    expect(within(dialog).getByLabelText(/Main/)).toBeDisabled(); // the current branch cannot be "switched to"
    expect(within(dialog).getByText('Current')).toBeInTheDocument();
  });

  it('requires an explicit choice: the confirm button stays disabled until a different branch is selected', async () => {
    await open();
    const confirm = await screen.findByRole('button', { name: 'Switch to this branch' });
    expect(confirm).toBeDisabled();
    fireEvent.submit(confirm.closest('form')!); // even a forced submit with nothing chosen does nothing
    expect(m.swap).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByLabelText(/Harbour/));
    expect(confirm).toBeEnabled();
  });

  it('submits the chosen branch and the branch this window believes is active, then shows the server-confirmed success', async () => {
    await open();
    fireEvent.click(await screen.findByLabelText(/Harbour/));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to this branch' }));
    expect(await screen.findByText('Now serving at Harbour.')).toBeInTheDocument();
    const sent = m.swap.mock.calls[0]![1] as FormData;
    expect(sent.get('branchId')).toBe('b2');
    expect(sent.get('fromBranchId')).toBe('b1');
    // The success message is shown from inside the pending transition, so wait for the form to settle before asserting it reset.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Switch to this branch' })).toBeDisabled()); // selection cleared after success
  });

  it('asking for the branch already active is reported as such', async () => {
    m.swap.mockResolvedValue({ status: 'unchanged', branchName: 'Main' });
    await open();
    fireEvent.click(await screen.findByLabelText(/Harbour/));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to this branch' }));
    expect(await screen.findByText('Already serving at Main.')).toBeInTheDocument();
  });

  it('a conflict (changed in another window) and a denial (no longer assigned) show a message and REFRESH the list', async () => {
    for (const [status, text] of [['conflict', 'Changed elsewhere.'], ['denied', 'No longer allowed.']] as const) {
      vi.clearAllMocks();
      m.list.mockResolvedValue(list([['b1', 'Main'], ['b2', 'Harbour']]));
      m.swap.mockResolvedValue({ status });
      const { unmount } = render(<BranchSwitcher currentBranchId="b1" currentBranchName="Main" copy={copy} />);
      fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
      fireEvent.click(await screen.findByLabelText(/Harbour/));
      fireEvent.click(screen.getByRole('button', { name: 'Switch to this branch' }));
      expect(await screen.findByText(text)).toBeInTheDocument();
      await waitFor(() => expect(m.list).toHaveBeenCalledTimes(2));
      unmount();
    }
  });

  it('a temporary failure shows a retryable message and does not reload or lose the selection', async () => {
    m.swap.mockResolvedValue({ status: 'unavailable' });
    await open();
    fireEvent.click(await screen.findByLabelText(/Harbour/));
    fireEvent.click(screen.getByRole('button', { name: 'Switch to this branch' }));
    expect(await screen.findByText('Not available now.')).toBeInTheDocument();
    expect(m.list).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(/Harbour/)).toBeChecked();
  });

  it('a failed branch load is an error with a retry, never an empty list', async () => {
    m.list.mockResolvedValueOnce({ status: 'failed' });
    await open();
    expect(await screen.findByText('Could not load.')).toBeInTheDocument();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    m.list.mockResolvedValueOnce(list([['b1', 'Main'], ['b2', 'Harbour']]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByLabelText(/Harbour/)).toBeInTheDocument();
  });

  it('reopening starts clean: no stale selection or message, and the list is fetched again', async () => {
    await open();
    fireEvent.click(await screen.findByLabelText(/Harbour/));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Switch branch' }));
    expect(await screen.findByLabelText(/Harbour/)).not.toBeChecked();
    expect(m.list).toHaveBeenCalledTimes(2);
  });

  it('works for a right-to-left language (Arabic copy)', async () => {
    const ar: BranchSwitcherCopy = { ...copy, button: 'تبديل الفرع', title: 'تبديل الفرع', confirm: 'التبديل إلى هذا الفرع', current: 'الحالي', success: 'أنت تخدم الآن في {branch}.' };
    render(<div dir="rtl"><BranchSwitcher currentBranchId="b1" currentBranchName="Main" copy={ar} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'تبديل الفرع' }));
    fireEvent.click(await screen.findByLabelText(/Harbour/));
    fireEvent.click(screen.getByRole('button', { name: 'التبديل إلى هذا الفرع' }));
    expect(await screen.findByText('أنت تخدم الآن في Harbour.')).toBeInTheDocument();
  });
});
