import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({
  api: vi.fn(), business: vi.fn(), revalidate: vi.fn(),
  cookieGet: vi.fn(), cookieSet: vi.fn(),
}));
vi.mock('@/lib/api-client', () => ({
  apiFetch: m.api,
  ApiError: class ApiError extends Error {
    constructor(message: string, public status: number, public code?: string) { super(message); }
  },
}));
vi.mock('@/lib/business', () => ({ getActiveBusiness: m.business }));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidate }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: m.cookieGet, set: m.cookieSet }) }));

import { ApiError } from '@/lib/api-client';
import { CASHIER_ADMIN_REAUTH_COOKIE } from '@/lib/cookies';
import {
  cashierAccountStatusAction, cashierReauthAction, createCashierAccountAction, resetCashierCredentialAction,
  setCashierBranchesAction,
} from './cashier-accounts';

const form = (entries: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) for (const x of Array.isArray(v) ? v : [v]) f.append(k, x);
  return f;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.business.mockResolvedValue({ id: 'biz-1' });
  m.api.mockResolvedValue({});
  m.cookieGet.mockReturnValue({ value: 'proof-token' });
});

describe('re-authentication proof (D-5)', () => {
  it('keeps the proof in an httpOnly, strict, 5 minute cookie scoped to the cashier area, and never returns it', async () => {
    m.api.mockResolvedValue({ proof: 'fresh-proof' });
    const state = await cashierReauthAction({}, form({ password: 'secret-pass' }));
    expect(state).toEqual({ status: 'reauthenticated' });
    expect(JSON.stringify(state)).not.toContain('fresh-proof');
    expect(m.cookieSet).toHaveBeenCalledWith(CASHIER_ADMIN_REAUTH_COOKIE, 'fresh-proof', expect.objectContaining({
      httpOnly: true, sameSite: 'strict', path: '/dashboard/cashier', maxAge: 300,
    }));
    expect(m.api).toHaveBeenCalledWith('/cashier-accounts/reauth', expect.objectContaining({ method: 'POST', businessId: 'biz-1' }));
  });

  it('a wrong password sets no cookie and reports the failure', async () => {
    m.api.mockRejectedValue(new ApiError('no', 401, 'INVALID_CREDENTIALS'));
    expect(await cashierReauthAction({}, form({ password: 'bad' }))).toEqual({ status: 'failed', error: 'INVALID_CREDENTIALS' });
    expect(m.cookieSet).not.toHaveBeenCalled();
  });

  it('every change forwards the proof from the cookie as X-Reauth-Proof, and asks for a fresh one when the API demands it', async () => {
    await cashierAccountStatusAction({}, form({ accountId: 'a1', action: 'disable' }));
    expect(m.api).toHaveBeenCalledWith('/cashier-accounts/a1/disable', { method: 'POST', businessId: 'biz-1', headers: { 'X-Reauth-Proof': 'proof-token' } });
    m.api.mockRejectedValue(new ApiError('re-enter', 403, 'REAUTH_REQUIRED'));
    expect(await cashierAccountStatusAction({}, form({ accountId: 'a1', action: 'disable' }))).toEqual({ status: 'reauthRequired' });
  });

  it('sends no proof header when the cookie is absent (the API then refuses with REAUTH_REQUIRED)', async () => {
    m.cookieGet.mockReturnValue(undefined);
    await cashierAccountStatusAction({}, form({ accountId: 'a1', action: 'disable' }));
    expect(m.api.mock.calls[0]![1]).toEqual({ method: 'POST', businessId: 'biz-1', headers: {} });
  });
});

describe('create', () => {
  it('sends the explicit mode, the branch ids and the password the owner chose, and returns only the sign-in details', async () => {
    m.api.mockResolvedValue({ account: { username: 'till1' }, cashierCode: 'ABCDEFGHJK' });
    const state = await createCashierAccountAction({}, form({
      username: ' till1 ', displayName: 'Till', accessMode: 'multiple', branchId: ['b1', 'b2'], cashierPassword: ' my own pass 1 ',
    }));
    expect(state).toEqual({ status: 'created', credential: { username: 'till1', cashierCode: 'ABCDEFGHJK' } });
    const [path, init] = m.api.mock.calls[0]!;
    expect(path).toBe('/cashier-accounts');
    // The password is sent exactly as typed (spaces are legal characters) and is never read back.
    expect(JSON.parse(init.body)).toEqual({ username: 'till1', displayName: 'Till', accessMode: 'multiple', branchIds: ['b1', 'b2'], password: ' my own pass 1 ' });
    expect(JSON.stringify(state)).not.toContain('my own pass');
    expect(m.revalidate).toHaveBeenCalledWith('/dashboard/cashier/accounts');
  });

  it('an invalid chosen password is reported by its API code, never swallowed or replaced by a generated one', async () => {
    m.api.mockRejectedValue(new ApiError('short', 422, 'CASHIER_PASSWORD_INVALID'));
    expect(await createCashierAccountAction({}, form({ username: 'till2', displayName: 'T', accessMode: 'single', branchId: 'b1', cashierPassword: 'short' })))
      .toEqual({ status: 'failed', error: 'CASHIER_PASSWORD_INVALID' });
    expect(m.api).toHaveBeenCalledTimes(1);
  });

  it('surfaces the API error code and never throws', async () => {
    m.api.mockRejectedValue(new ApiError('taken', 409, 'CASHIER_USERNAME_TAKEN'));
    expect(await createCashierAccountAction({}, form({ username: 'x', displayName: 'x', accessMode: 'single', branchId: 'b1' })))
      .toEqual({ status: 'failed', error: 'CASHIER_USERNAME_TAKEN' });
    m.api.mockRejectedValue(new Error('down'));
    expect(await cashierAccountStatusAction({}, form({ accountId: 'a1', action: 'disable' }))).toEqual({ status: 'failed' });
  });

  it('does nothing without an active business', async () => {
    m.business.mockResolvedValue(null);
    expect(await cashierAccountStatusAction({}, form({ accountId: 'a1', action: 'disable' }))).toEqual({ status: 'failed' });
    expect(m.api).not.toHaveBeenCalled();
  });
});

describe('branches, reset and status', () => {
  it('replaces the assignment with exactly the ticked branches, with the id encoded in the path', async () => {
    await setCashierBranchesAction({}, form({ accountId: '../../team', accessMode: 'multiple', branchId: ['b1', 'b2'] }));
    const [path, init] = m.api.mock.calls[0]!;
    expect(path).toBe('/cashier-accounts/..%2F..%2Fteam/branches');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ accessMode: 'multiple', branchIds: ['b1', 'b2'] });
  });

  it('a password change sends exactly the password the owner typed and returns no credential', async () => {
    m.api.mockResolvedValue({ changed: true });
    const state = await resetCashierCredentialAction({}, form({ accountId: 'a1', newPassword: 'the new one 77' }));
    expect(state).toEqual({ status: 'credentialReset' });
    expect(m.api.mock.calls[0]![0]).toBe('/cashier-accounts/a1/reset-credential');
    expect(JSON.parse(m.api.mock.calls[0]![1].body)).toEqual({ password: 'the new one 77' });
  });

  it('there is no business-code rotation action any more: the business code is permanent', async () => {
    const actions = await import('./cashier-accounts');
    expect(Object.keys(actions).some((name) => /rotate/i.test(name))).toBe(false);
  });

  it('only the four known status actions reach the API; anything else is refused locally', async () => {
    for (const action of ['disable', 'enable', 'revoke', 'revoke-sessions']) {
      await cashierAccountStatusAction({}, form({ accountId: 'a1', action }));
    }
    expect(m.api.mock.calls.map((c) => c[0])).toEqual([
      '/cashier-accounts/a1/disable', '/cashier-accounts/a1/enable', '/cashier-accounts/a1/revoke', '/cashier-accounts/a1/revoke-sessions',
    ]);
    m.api.mockClear();
    expect(await cashierAccountStatusAction({}, form({ accountId: 'a1', action: 'reset-credential/../x' }))).toEqual({ status: 'failed' });
    expect(await cashierAccountStatusAction({}, form({ accountId: 'a1', action: '' }))).toEqual({ status: 'failed' });
    expect(m.api).not.toHaveBeenCalled();
  });
});
