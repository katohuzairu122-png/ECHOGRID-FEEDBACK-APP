import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({
  post: vi.fn(),
  ensure: vi.fn(),
  setSession: vi.fn(),
  clear: vi.fn(),
  refreshToken: vi.fn(),
  ticket: vi.fn(),
  setTicket: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  }),
  serve: vi.fn(),
  lookup: vi.fn(),
  confirm: vi.fn(),
  surface: [] as boolean[],
  context: vi.fn(),
  revalidate: vi.fn(),
  apiFetch: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('./auth-api', () => ({ postCashierAuth: m.post, ensureCashierAccess: m.ensure }));
vi.mock('./session', () => ({
  setCashierSession: m.setSession,
  clearCashierSession: m.clear,
  getCashierRefreshToken: m.refreshToken,
  getCashierContext: m.context,
  getCashierSelectionTicket: m.ticket,
  setCashierSelectionTicket: m.setTicket,
}));
vi.mock('../api-client', () => ({ apiFetch: m.apiFetch }));
vi.mock('./host-guard', () => ({ requireCashierOrigin: async () => undefined })); // origin rules are tested in host-isolation.test.ts
vi.mock('../actions/unified-qr', () => ({ staffUnifiedQrAction: m.serve }));
vi.mock('../actions/loyalty', () => ({ lookupRedemptionAction: m.lookup, confirmRedemptionAction: m.confirm }));

import { ApiError } from '../api-error';
import { isCashierSurface } from './surface';
import {
  cashierConfirmRedemptionAction,
  cashierLoginAction,
  cashierLogoutAction,
  cashierLookupRedemptionAction,
  cashierSelectAction,
  cashierServeAction,
  cashierSwitchBranchAction,
  cashierListBranchesAction,
  cashierIssueInviteAction,
} from './actions';

const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const redirected = async (p: Promise<unknown>) => p.then(() => null, (e: { digest?: string }) => e.digest ?? String(e));

beforeEach(() => {
  vi.clearAllMocks();
  m.ensure.mockResolvedValue(true);
  m.context.mockResolvedValue({ businessId: 'b', branchId: 'branch-1', businessName: 'Biz', branchName: 'One', deviceLabel: null, canSwitchBranch: true });
  m.refreshToken.mockResolvedValue('refresh-token-1');
});

describe('cashier sign-in', () => {
  it('authenticated: stores the cashier session and goes to the counter', async () => {
    const session = { status: 'authenticated', accessToken: 'a', refreshToken: 'r', session: { businessId: 'b', branchId: null, deviceLabel: null } };
    m.post.mockResolvedValue(session);
    const out = await redirected(cashierLoginAction({}, form({ email: 'a@b.test', password: 'pw', deviceLabel: 'Counter 1' })));
    expect(m.post).toHaveBeenCalledWith('login', { email: 'a@b.test', password: 'pw', deviceLabel: 'Counter 1' });
    expect(m.setSession).toHaveBeenCalledWith(session);
    expect(out).toContain('/cashier');
  });

  it('selection required: keeps the ticket server-side and returns only the choices', async () => {
    const choices = [{ businessId: 'b1', businessName: 'One', wideAccess: true, branches: [] }];
    m.post.mockResolvedValue({ status: 'selection_required', ticket: 'TICKET', choices });
    const state = await cashierLoginAction({}, form({ email: 'a@b.test', password: 'pw' }));
    expect(state).toEqual({ choices });
    expect(JSON.stringify(state)).not.toContain('TICKET');
    expect(m.setTicket).toHaveBeenCalledWith('TICKET');
    expect(m.setSession).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_CREDENTIALS', 401, 'credentials'],
    ['CASHIER_ACCESS_DENIED', 403, 'access'],
    ['ACCOUNT_INACTIVE', 403, 'access'],
    ['CASHIER_SELECTION_INVALID', 400, 'expired'],
    ['RATE_LIMITED', 429, 'unavailable'],
  ])('%s maps to a safe error kind and starts no session', async (code, status, kind) => {
    m.post.mockRejectedValue(new ApiError('x', status, code));
    expect(await cashierLoginAction({}, form({ email: 'a@b.test', password: 'pw' }))).toEqual({ error: kind });
    expect(m.setSession).not.toHaveBeenCalled();
  });

  it('an unreachable API is a generic unavailable state', async () => {
    m.post.mockRejectedValue(new Error('network'));
    expect(await cashierLoginAction({}, form({ email: 'a@b.test', password: 'pw' }))).toEqual({ error: 'unavailable' });
  });

  it('step 2 uses the stored ticket, never a client-supplied one, and expires cleanly without it', async () => {
    m.ticket.mockResolvedValue(undefined);
    expect(await cashierSelectAction({}, form({ businessId: 'b', ticket: 'forged' }))).toEqual({ error: 'expired' });
    expect(m.post).not.toHaveBeenCalled();
    m.ticket.mockResolvedValue('REAL');
    m.post.mockResolvedValue({ status: 'authenticated', accessToken: 'a', refreshToken: 'r', session: { businessId: 'b', branchId: 'br', deviceLabel: null } });
    await redirected(cashierSelectAction({}, form({ businessId: 'b', branchId: 'br', ticket: 'forged' })));
    expect(m.post).toHaveBeenCalledWith('session', { ticket: 'REAL', businessId: 'b', branchId: 'br' });
    expect(m.setSession).toHaveBeenCalled();
  });
});

describe('cashier sign-out', () => {
  it('ends only this cashier session and clears cashier cookies, then goes to the sign-in', async () => {
    m.refreshToken.mockResolvedValue('REFRESH');
    m.post.mockResolvedValue(undefined);
    const out = await redirected(cashierLogoutAction());
    expect(m.post).toHaveBeenCalledWith('logout', { refreshToken: 'REFRESH' });
    expect(m.clear).toHaveBeenCalled();
    expect(out).toContain('/cashier/login');
  });

  it('clears local cookies even when the server call fails', async () => {
    m.refreshToken.mockResolvedValue('REFRESH');
    m.post.mockRejectedValue(new Error('down'));
    await redirected(cashierLogoutAction());
    expect(m.clear).toHaveBeenCalled();
  });
});

describe('cashier serve actions', () => {
  it('run the existing Serve Customers actions under the cashier surface', async () => {
    m.serve.mockImplementation(async () => ({ seen: isCashierSurface() }));
    m.lookup.mockImplementation(async () => ({ error: String(isCashierSurface()) }));
    m.confirm.mockImplementation(async () => ({ id: String(isCashierSurface()) }));
    expect(await cashierServeAction({}, form({}))).toEqual({ seen: true });
    expect(await cashierLookupRedemptionAction('branch-1', {}, form({}))).toEqual({ error: 'true' });
    expect(await cashierConfirmRedemptionAction('branch-1', 'CODE')).toEqual({ id: 'true' });
    expect(isCashierSurface()).toBe(false);
  });

  it('a dead cashier session sends the user to the sign-in without running the action', async () => {
    m.ensure.mockResolvedValue(false);
    const out = await redirected(cashierServeAction({}, form({})));
    expect(out).toContain('/cashier/login');
    expect(m.serve).not.toHaveBeenCalled();
  });
});

describe('CASHIER-AUTH-02C: a screen drawn for one branch never acts after the session moved to another', () => {
  it('serve: a form drawn for another branch is redirected to the counter and the action does not run', async () => {
    m.context.mockResolvedValue({ businessId: 'b', branchId: 'branch-2', businessName: 'Biz', branchName: 'Two', deviceLabel: null, canSwitchBranch: true });
    m.serve.mockResolvedValue({});
    expect(await redirected(cashierServeAction({}, form({ branchId: 'branch-1' })))).toContain('/cashier;');
    expect(m.serve).not.toHaveBeenCalled();
  });

  it('serve: a form for the current branch runs normally', async () => {
    m.serve.mockResolvedValue({ ok: true });
    expect(await cashierServeAction({}, form({ branchId: 'branch-1' }))).toEqual({ ok: true });
  });

  it('redeem lookup and confirm: bound to the drawn branch; a mismatch redirects without running', async () => {
    m.context.mockResolvedValue({ businessId: 'b', branchId: 'branch-2', businessName: 'Biz', branchName: 'Two', deviceLabel: null, canSwitchBranch: true });
    expect(await redirected(cashierLookupRedemptionAction('branch-1', {}, form({})))).toContain('/cashier;');
    expect(await redirected(cashierConfirmRedemptionAction('branch-1', 'CODE'))).toContain('/cashier;');
    expect(m.lookup).not.toHaveBeenCalled();
    expect(m.confirm).not.toHaveBeenCalled();
  });

  it('a business-wide screen (no branch) matches a business-wide session', async () => {
    m.context.mockResolvedValue({ businessId: 'b', branchId: null, businessName: 'Biz', branchName: null, deviceLabel: null, canSwitchBranch: false });
    m.confirm.mockResolvedValue({ id: 'ok' });
    expect(await cashierConfirmRedemptionAction(null, 'CODE')).toEqual({ id: 'ok' });
  });
});

describe('CASHIER-AUTH-02C: switching branches', () => {
  const payload = (branch: string) => ({
    switched: true, accessToken: 'new-access', refreshToken: 'new-refresh',
    session: { businessId: 'b', branchId: branch, deviceLabel: null, businessName: 'Biz', branchName: 'Two', canSwitchBranch: true },
  });

  it('sends the session refresh token, the chosen branch and the branch this window believes is active', async () => {
    m.post.mockResolvedValue(payload('branch-2'));
    await cashierSwitchBranchAction({}, form({ branchId: 'branch-2', fromBranchId: 'branch-1' }));
    expect(m.post).toHaveBeenCalledWith('switch-branch', { refreshToken: 'refresh-token-1', branchId: 'branch-2', fromBranchId: 'branch-1' });
  });

  it('on success replaces the cashier session cookies with the new branch binding and revalidates the counter', async () => {
    m.post.mockResolvedValue(payload('branch-2'));
    expect(await cashierSwitchBranchAction({}, form({ branchId: 'branch-2', fromBranchId: 'branch-1' }))).toEqual({ status: 'switched', branchName: 'Two' });
    expect(m.setSession).toHaveBeenCalledWith({ accessToken: 'new-access', refreshToken: 'new-refresh', session: expect.objectContaining({ branchId: 'branch-2' }) });
    expect(m.revalidate).toHaveBeenCalledWith('/cashier', 'layout');
    expect(m.clear).not.toHaveBeenCalled();
  });

  it('asking for the branch already active changes no cookie', async () => {
    m.post.mockResolvedValue({ switched: false, session: { businessId: 'b', branchId: 'branch-1', deviceLabel: null, branchName: 'One', canSwitchBranch: true } });
    expect(await cashierSwitchBranchAction({}, form({ branchId: 'branch-1' }))).toEqual({ status: 'unchanged', branchName: 'One' });
    expect(m.setSession).not.toHaveBeenCalled();
  });

  it('never returns a token to the browser', async () => {
    m.post.mockResolvedValue(payload('branch-2'));
    const out = await cashierSwitchBranchAction({}, form({ branchId: 'branch-2' }));
    expect(JSON.stringify(out)).not.toMatch(/new-access|new-refresh|refresh-token-1/);
  });

  it('maps refusals without touching the cookies: denied, conflict (stale window or concurrent switch) and unavailable', async () => {
    for (const [code, status, expected] of [
      ['CASHIER_ACCESS_DENIED', 403, 'denied'], ['CASHIER_SWITCH_NOT_AVAILABLE', 403, 'denied'],
      ['CASHIER_SWITCH_CONFLICT', 409, 'conflict'], ['REFRESH_TOKEN_ROTATED', 409, 'conflict'],
      ['SOMETHING_ELSE', 500, 'unavailable'], ['RATE_LIMITED', 429, 'unavailable'],
    ] as const) {
      m.post.mockRejectedValueOnce(new ApiError('x', status, code));
      expect((await cashierSwitchBranchAction({}, form({ branchId: 'branch-2' }))).status, code).toBe(expected);
    }
    m.post.mockRejectedValueOnce(new Error('network down'));
    expect((await cashierSwitchBranchAction({}, form({ branchId: 'branch-2' }))).status).toBe('unavailable');
    expect(m.setSession).not.toHaveBeenCalled();
    expect(m.clear).not.toHaveBeenCalled();
  });

  it('an ended session (revoked, disabled, replayed, access removed) clears the cashier cookies and goes to the sign-in', async () => {
    for (const code of ['INVALID_REFRESH_TOKEN', 'ACCOUNT_INACTIVE', 'CASHIER_ACCESS_REVOKED']) {
      m.clear.mockClear();
      m.post.mockRejectedValueOnce(new ApiError('x', 401, code));
      expect(await redirected(cashierSwitchBranchAction({}, form({ branchId: 'branch-2' })))).toContain('/cashier/login?reason=session');
      expect(m.clear).toHaveBeenCalledTimes(1);
    }
  });

  it('no refresh cookie: sign in, and nothing is sent', async () => {
    m.refreshToken.mockResolvedValue(undefined);
    expect(await redirected(cashierSwitchBranchAction({}, form({ branchId: 'branch-2' })))).toContain('/cashier/login');
    expect(m.post).not.toHaveBeenCalled();
  });

  it('an empty branch choice is refused locally (a branch must be chosen explicitly)', async () => {
    expect(await cashierSwitchBranchAction({}, form({}))).toEqual({ status: 'denied' });
    expect(m.post).not.toHaveBeenCalled();
  });

  it('listing: returns the current branch and only what the server lists; failures are retryable; an ended session signs out', async () => {
    m.post.mockResolvedValue({ current: { id: 'branch-1', name: 'One' }, branches: [{ id: 'branch-1', name: 'One' }, { id: 'branch-2', name: 'Two' }], canSwitchBranch: true });
    expect(await cashierListBranchesAction()).toEqual({ status: 'ready', branches: [{ id: 'branch-1', name: 'One' }, { id: 'branch-2', name: 'Two' }], currentBranchId: 'branch-1' });
    expect(m.post).toHaveBeenCalledWith('branches', { refreshToken: 'refresh-token-1' });
    m.post.mockRejectedValueOnce(new ApiError('x', 500, 'BOOM'));
    expect(await cashierListBranchesAction()).toEqual({ status: 'failed' });
    m.post.mockRejectedValueOnce(new ApiError('x', 401, 'INVALID_REFRESH_TOKEN'));
    expect(await redirected(cashierListBranchesAction())).toContain('/cashier/login?reason=session');
  });
});

describe('CASHIER-AUTH-02D: onboarding invitations', () => {
  const ready = { inviteUrl: 'https://customers.example.test/loyalty/invite/tok', expiresAt: '2026-11-19T10:10:00.000Z', branchId: 'branch-1', inviteToken: 'tok' };

  it('asks the API for an invitation as the cashier, with no body, and returns only the link, expiry and branch', async () => {
    m.apiFetch.mockImplementation(async () => { m.surface.push(isCashierSurface()); return ready; });
    const out = await cashierIssueInviteAction('branch-1');
    expect(m.apiFetch).toHaveBeenCalledWith('/loyalty/actions/onboarding-invite', { method: 'POST', cache: 'no-store' });
    expect(m.surface).toEqual([true]); // under the cashier credential, never the staff one
    expect(out).toEqual({ status: 'ready', inviteUrl: ready.inviteUrl, expiresAt: ready.expiresAt, branchId: 'branch-1' });
    expect(JSON.stringify(out)).not.toContain('inviteToken');
  });

  it('a window drawn for another branch is sent back to the counter and asks nothing', async () => {
    expect(await redirected(cashierIssueInviteAction('branch-2'))).toContain('/cashier;');
    expect(m.apiFetch).not.toHaveBeenCalled();
  });

  it('maps refusals to states the screen can explain, and never throws a raw error to the browser', async () => {
    for (const [status, code, expected] of [
      [429, 'RATE_LIMITED', 'rate_limited'], [409, 'ONBOARDING_INVITE_BRANCH_REQUIRED', 'branch_required'], [500, 'BOOM', 'unavailable'], [403, 'ONBOARDING_INVITE_CASHIER_ONLY', 'unavailable'],
    ] as const) {
      m.apiFetch.mockRejectedValueOnce(new ApiError('x', status, code));
      expect(await cashierIssueInviteAction('branch-1'), `${status} ${code}`).toEqual({ status: expected });
    }
    m.apiFetch.mockRejectedValueOnce(new Error('network'));
    expect(await cashierIssueInviteAction('branch-1')).toEqual({ status: 'unavailable' });
  });

  it('an ended session (revoked, disabled, signed out elsewhere) clears the cookies and returns to sign-in', async () => {
    for (const code of ['CASHIER_ACCESS_REVOKED', 'ACCOUNT_INACTIVE', 'INVALID_REFRESH_TOKEN']) {
      m.clear.mockClear();
      m.apiFetch.mockRejectedValueOnce(new ApiError('x', 403, code));
      expect(await redirected(cashierIssueInviteAction('branch-1'))).toContain('/cashier/login?reason=session');
      expect(m.clear).toHaveBeenCalledTimes(1);
    }
  });

  it('an expired cashier access that cannot be renewed redirects to sign-in before any API call', async () => {
    m.ensure.mockResolvedValueOnce(false);
    expect(await redirected(cashierIssueInviteAction('branch-1'))).toContain('/cashier/login');
    expect(m.apiFetch).not.toHaveBeenCalled();
  });
});
