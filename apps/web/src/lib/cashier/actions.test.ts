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
}));
vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('./auth-api', () => ({ postCashierAuth: m.post, ensureCashierAccess: m.ensure }));
vi.mock('./session', () => ({
  setCashierSession: m.setSession,
  clearCashierSession: m.clear,
  getCashierRefreshToken: m.refreshToken,
  getCashierSelectionTicket: m.ticket,
  setCashierSelectionTicket: m.setTicket,
}));
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
    expect(await cashierLookupRedemptionAction({}, form({}))).toEqual({ error: 'true' });
    expect(await cashierConfirmRedemptionAction('CODE')).toEqual({ id: 'true' });
    expect(isCashierSurface()).toBe(false);
  });

  it('a dead cashier session sends the user to the sign-in without running the action', async () => {
    m.ensure.mockResolvedValue(false);
    const out = await redirected(cashierServeAction({}, form({})));
    expect(out).toContain('/cashier/login');
    expect(m.serve).not.toHaveBeenCalled();
  });
});
