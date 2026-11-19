import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const m = vi.hoisted(() => ({ issue: vi.fn() }));
vi.mock('@/lib/cashier/actions', () => ({ cashierIssueInviteAction: m.issue }));
vi.mock('react-qr-code', () => ({ default: (p: { value: string }) => <svg data-testid="qr" data-value={p.value} /> }));

import { InvitePanel, type InvitePanelCopy } from './invite-panel';

const copy: InvitePanelCopy = {
  intro: 'Create a one-time code.', create: 'Create invitation', creating: 'Creating…', another: 'Create a new invitation', qrLabel: 'Invitation QR',
  scanHint: 'Ask the customer to scan this.', validFor: 'Valid for {time}', expiredTitle: 'Expired', expiredBody: 'Create a new one.', copy: 'Copy link',
  copied: 'Link copied', copyFailed: 'Could not copy.', rateLimited: 'Too many invitations.', branchRequired: 'Choose a branch.', unavailable: 'Not available.',
};
const ready = (expiresInMs = 600_000, url = 'https://customers.example.test/loyalty/invite/tok') => ({ status: 'ready', inviteUrl: url, expiresAt: new Date(Date.now() + expiresInMs).toISOString(), branchId: 'b1' });
const mount = () => render(<InvitePanel expectedBranchId="b1" branchName="Main" copy={copy} />);

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe('cashier invitation screen (CASHIER-AUTH-02D)', () => {
  it('creates nothing on its own: an invitation is issued only when the cashier asks, and is bound to the branch the screen was drawn for', async () => {
    m.issue.mockResolvedValue(ready());
    mount();
    expect(m.issue).not.toHaveBeenCalled();
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invitation' })); });
    expect(m.issue).toHaveBeenCalledExactlyOnceWith('b1');
  });

  it('shows the invitation as a QR code of the customer link, with a countdown, and offers a new one', async () => {
    m.issue.mockResolvedValue(ready(600_000, 'https://customers.example.test/loyalty/invite/abc.def.ghi'));
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invitation' })); });
    expect(screen.getByTestId('qr')).toHaveAttribute('data-value', 'https://customers.example.test/loyalty/invite/abc.def.ghi');
    expect(screen.getByRole('img', { name: 'Invitation QR' })).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/Valid for (9:5\d|10:00)/);
    expect(screen.getByRole('button', { name: 'Create a new invitation' })).toBeEnabled();
  });

  it('counts down and, when the invitation expires, removes the code and says so (an expired code is never left on screen)', async () => {
    m.issue.mockResolvedValue(ready(3_000));
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invitation' })); });
    expect(screen.getByTestId('qr')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(4_000); });
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Expired');
  });

  it('explains each refusal and shows no code', async () => {
    for (const [status, text] of [['rate_limited', 'Too many invitations.'], ['branch_required', 'Choose a branch.'], ['unavailable', 'Not available.']] as const) {
      m.issue.mockResolvedValueOnce({ status });
      const { unmount } = mount();
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invitation' })); });
      expect(screen.getByRole('alert')).toHaveTextContent(text);
      expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('an unexpected failure shows the generic message, never a raw error', async () => {
    m.issue.mockRejectedValueOnce(new Error('network down'));
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invitation' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Not available.');
    expect(screen.queryByText(/network down/)).not.toBeInTheDocument();
  });

  it('copies the link, and says when it could not', async () => {
    m.issue.mockResolvedValue(ready());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create invitation' })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link' })); });
    expect(writeText).toHaveBeenCalledWith('https://customers.example.test/loyalty/invite/tok');
    expect(screen.getByRole('button', { name: 'Link copied' })).toBeInTheDocument();
    writeText.mockRejectedValueOnce(new Error('denied'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Link copied' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not copy.');
  });

  it('the screen never shows or asks for any customer detail', () => {
    mount();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/phone|email|name/i)).not.toBeInTheDocument();
  });
});
