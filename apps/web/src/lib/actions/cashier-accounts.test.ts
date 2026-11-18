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
  rotateCashierCodeAction, setCashierBranchesAction,
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
    await rotateCashierCodeAction();
    expect(m.api).toHaveBeenCalledWith('/cashier-accounts/business-code/rotate', { method: 'POST', businessId: 'biz-1', headers: { 'X-Reauth-Proof': 'proof-token' } });
    m.api.mockRejectedValue(new ApiError('re-enter', 403, 'REAUTH_REQUIRED'));
    expect(await rotateCashierCodeAction()).toEqual({ status: 'reauthRequired' });
  });

  it('sends no proof header when the cookie is absent (the API then refuses with REAUTH_REQUIRED)', async () => {
    m.cookieGet.mockReturnValue(undefined);
    await rotateCashierCodeAction();
    expect(m.api.mock.calls[0]![1]).toEqual({ method: 'POST', businessId: 'biz-1', headers: {} });
  });
});

describe('create', () => {
  it('sends the explicit mode and branch ids, omits an empty password, and returns the one-time credential', async () => {
    m.api.mockResolvedValue({ account: { username: 'till1' }, initialPassword: 'Gen3ratedPass', cashierCode: 'ABCDEFGHJK' });
    const state = await createCashierAccountAction({}, form({
      username: ' till1 ', displayName: 'Till', accessMode: 'multiple', branchId: ['b1', 'b2'], password: '',
    }));
    expect(state).toEqual({ status: 'created', credential: { username: 'till1', password: 'Gen3ratedPass', cashierCode: 'ABCDEFGHJK' } });
    const [path, init] = m.api.mock.calls[0]!;
    expect(path).toBe('/cashier-accounts');
    expect(JSON.parse(init.body)).toEqual({ username: 'till1', displayName: 'Till', accessMode: 'multiple', branchIds: ['b1', 'b2'] });
    expect(m.revalidate).toHaveBeenCalledWith('/dashboard/cashier/accounts');
  });

  it('an administrator-chosen password is sent but never echoed back', async () => {
    m.api.mockResolvedValue({ account: { username: 'till2' }, initialPassword: null, cashierCode: 'ABCDEFGHJK' });
    const state = await createCashierAccountAction({}, form({ username: 'till2', displayName: 'T', accessMode: 'single', branchId: 'b1', password: 'chosen-password' }));
    expect(state.credential?.password).toBe('');
    expect(JSON.parse(m.api.mock.calls[0]![1].body).password).toBe('chosen-password');
    expect(JSON.stringify(state)).not.toContain('chosen-password');
  });

  it('surfaces the API error code and never throws', async () => {
    m.api.mockRejectedValue(new ApiError('taken', 409, 'CASHIER_USERNAME_TAKEN'));
    expect(await createCashierAccountAction({}, form({ username: 'x', displayName: 'x', accessMode: 'single', branchId: 'b1' })))
      .toEqual({ status: 'failed', error: 'CASHIER_USERNAME_TAKEN' });
    m.api.mockRejectedValue(new Error('down'));
    expect(await rotateCashierCodeAction()).toEqual({ status: 'failed' });
  });

  it('does nothing without an active business', async () => {
    m.business.mockResolvedValue(null);
    expect(await rotateCashierCodeAction()).toEqual({ status: 'failed' });
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

  it('a reset returns the new password once, for the named account', async () => {
    m.api.mockResolvedValue({ initialPassword: 'NewPass1234567890abcdefg' });
    const state = await resetCashierCredentialAction({}, form({ accountId: 'a1', username: 'till1' }));
    expect(state).toEqual({ status: 'credentialReset', credential: { username: 'till1', password: 'NewPass1234567890abcdefg' } });
    expect(m.api.mock.calls[0]![0]).toBe('/cashier-accounts/a1/reset-credential');
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
