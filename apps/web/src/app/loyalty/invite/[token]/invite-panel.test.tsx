import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithIntl as render } from '@/test-utils';
import type { AssistedInvitePreviewDto } from '@echo-grid-feedback/shared-types';

const m = vi.hoisted(() => ({ join: vi.fn() }));
vi.mock('@/lib/actions/loyalty-customer', () => ({ joinAssistedAction: m.join }));

import { InvitePanel } from './invite-panel';

const TOKEN = 'tok.part.sig';
const preview = (over: Partial<AssistedInvitePreviewDto> = {}): AssistedInvitePreviewDto => ({
  status: 'ready', businessName: 'Echo Cafe', branchName: 'Harbour', businessId: 'biz-1', expiresAt: '2026-11-19T10:10:00.000Z', ...over,
});
const ui = (over: Partial<Parameters<typeof InvitePanel>[0]> = {}) => (
  <InvitePanel token={TOKEN} signedIn preview={preview()} invalid={false} {...over} />
);

beforeEach(() => vi.clearAllMocks());

describe('customer invitation page (CASHIER-AUTH-02D)', () => {
  it('a signed-out visitor sees only sign-in and sign-up links that return here, and nothing about the invitation', () => {
    render(ui({ signedIn: false, preview: null }));
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', `/loyalty/login?next=${encodeURIComponent(`/loyalty/invite/${TOKEN}`)}`);
    expect(screen.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', `/loyalty/signup?next=${encodeURIComponent(`/loyalty/invite/${TOKEN}`)}`);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Echo Cafe/)).not.toBeInTheDocument();
  });

  it('shows the business and branch and requires explicit consent: Join stays disabled until the box is ticked', async () => {
    const user = userEvent.setup();
    render(ui());
    expect(screen.getByText('Join Echo Cafe')).toBeInTheDocument();
    expect(screen.getByText('You were invited at Harbour.')).toBeInTheDocument();
    const join = screen.getByRole('button', { name: 'Join' });
    expect(join).toBeDisabled();
    await user.click(join);
    expect(m.join).not.toHaveBeenCalled();
    await user.click(screen.getByRole('checkbox'));
    expect(join).toBeEnabled();
  });

  it('joins with the invitation token and the consent, and nothing else, then shows the success state with a link to the rewards', async () => {
    const user = userEvent.setup();
    m.join.mockResolvedValue({ account: { id: 'a', businessId: 'biz-1', points: 0 } });
    render(ui());
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(screen.getByText("You're in")).toBeInTheDocument());
    expect(m.join).toHaveBeenCalledExactlyOnceWith(TOKEN, true);
    expect(screen.getByText('You have joined Echo Cafe.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View your rewards' })).toHaveAttribute('href', '/loyalty/dashboard/biz-1');
  });

  it('an already-enrolled customer is told so and offered the rewards; nothing to accept', () => {
    render(ui({ preview: preview({ status: 'already_member' }) }));
    expect(screen.getByText("You're already a member of Echo Cafe")).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View your rewards' })).toHaveAttribute('href', '/loyalty/dashboard/biz-1');
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
  });

  it('an invitation someone else already used, and an expired or invalid one, say to ask the cashier for a new one', () => {
    const { unmount } = render(ui({ preview: preview({ status: 'used' }) }));
    expect(screen.getByText('This invitation was already used')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join' })).not.toBeInTheDocument();
    unmount();
    render(ui({ preview: null, invalid: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('This invitation is not valid');
    expect(screen.getByRole('alert')).toHaveTextContent('Ask the cashier for a new one');
  });

  it('explains each refusal after consenting: no longer valid, already used, and a phone check for an additional business', async () => {
    const user = userEvent.setup();
    render(ui());
    await user.click(screen.getByRole('checkbox'));
    m.join.mockResolvedValueOnce({ error: 'x', code: 'ONBOARDING_INVITE_INVALID' });
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This invitation is no longer valid. Ask the cashier for a new one.');
    m.join.mockResolvedValueOnce({ error: 'x', code: 'ONBOARDING_INVITE_USED' });
    await user.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Ask the cashier for a new one.'));
    m.join.mockResolvedValueOnce({ error: 'x', code: 'PHONE_VERIFICATION_REQUIRED' });
    await user.click(screen.getByRole('button', { name: 'Join' }));
    const verify = await screen.findByRole('link', { name: 'Verify my phone' });
    expect(verify).toHaveAttribute('href', `/loyalty/dashboard/phone?next=${encodeURIComponent(`/loyalty/invite/${TOKEN}`)}`);
  });

  it('an unexpected failure shows a generic message and never a raw error', async () => {
    const user = userEvent.setup();
    m.join.mockRejectedValueOnce(new Error('kaboom'));
    render(ui());
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    expect(screen.queryByText(/kaboom/)).not.toBeInTheDocument();
  });
});
