import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCookieStore } from './cashier-test-support';

/**
 * SEC-CASHIER-R2 F4: the host boundary is enforced where actions run, not only in page layouts. These tests call the
 * action functions directly (what a forged POST carrying an action id ends up doing), with only the request Host varied.
 */
vi.mock('server-only', () => ({}));
const state = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
const jar = createCookieStore();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => state.headers[k.toLowerCase()] ?? null }),
  cookies: async () => jar.store,
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  },
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
const api = vi.hoisted(() => ({ post: vi.fn(), staffFetch: vi.fn() }));
vi.mock('./auth-api', () => ({ postCashierAuth: api.post, ensureCashierAccess: async () => true }));
vi.mock('../actions/unified-qr', () => ({ staffUnifiedQrAction: vi.fn(async () => ({})) }));
vi.mock('../actions/loyalty', () => ({ lookupRedemptionAction: vi.fn(async () => ({})), confirmRedemptionAction: vi.fn(async () => ({})) }));

import { apiFetch } from '../api-client';
import { setSession, startImpersonation } from '../session';
import { runInCashierSurface } from './surface';
import {
  cashierConfirmRedemptionAction,
  cashierLoginAction,
  cashierLogoutAction,
  cashierLookupRedemptionAction,
  cashierSelectAction,
  cashierServeAction,
} from './actions';

const CASHIER = 'cashier.echo-grid.uk';
const MAIN = 'echo-grid.uk';
const form = () => {
  const f = new FormData();
  f.set('email', 'a@b.test');
  f.set('password', 'pw');
  return f;
};
const outcome = (p: Promise<unknown>) => p.then(() => 'ran', (e: { digest?: string; message?: string }) => e.digest ?? e.message ?? 'error');
const host = (h: string, extra: Record<string, string> = {}) => {
  state.headers = { host: h, ...extra };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CASHIER_HOST', CASHIER);
  jar.jar.clear();
  api.post.mockResolvedValue({ status: 'selection_required', ticket: 't', choices: [] });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { ok: true } })));
});

describe('cashier actions refuse every host except the cashier host', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['cashierLoginAction', () => cashierLoginAction({}, form())],
    ['cashierSelectAction', () => cashierSelectAction({}, form())],
    ['cashierLogoutAction', () => cashierLogoutAction()],
    ['cashierServeAction', () => cashierServeAction({}, form())],
    ['cashierLookupRedemptionAction', () => cashierLookupRedemptionAction({}, form())],
    ['cashierConfirmRedemptionAction', () => cashierConfirmRedemptionAction('CODE')],
  ];

  it.each(calls)('%s on the main host is a 404 and reaches nothing', async (_n, run) => {
    host(MAIN);
    expect(await outcome(run())).toContain('404');
    expect(api.post).not.toHaveBeenCalled();
    expect(jar.jar.size).toBe(0);
  });

  it.each(calls)('%s on the cashier host is allowed to run', async (_n, run) => {
    host(CASHIER);
    expect(await outcome(run())).not.toContain('404');
  });

  it('forged forwarded-host headers do not change which host the request addressed', async () => {
    host(MAIN, { 'x-forwarded-host': CASHIER, 'x-original-host': CASHIER, forwarded: `host=${CASHIER}`, 'x-host': CASHIER });
    expect(await outcome(cashierLoginAction({}, form()))).toContain('404');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('an unconfigured or malformed CASHIER_HOST makes every cashier action a 404, even on the "cashier" host', async () => {
    host(CASHIER);
    for (const value of ['', 'https://cashier.echo-grid.uk', 'cashier.echo-grid.uk/x']) {
      vi.stubEnv('CASHIER_HOST', value);
      expect(await outcome(cashierLoginAction({}, form())), value).toContain('404');
    }
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('staff sessions and the staff API never operate on the cashier-only origin', () => {
  const tokens = { accessToken: 'a', refreshToken: 'r' };

  it('setSession and startImpersonation are refused on the cashier host and write no cookie', async () => {
    host(CASHIER);
    expect(await outcome(setSession(tokens))).toContain('404');
    expect(await outcome(startImpersonation({ accessToken: 'a', expiresAt: new Date(Date.now() + 1000) }))).toContain('404');
    expect(jar.jar.size).toBe(0);
  });

  it('setSession still works on the main host (ordinary staff sign-in is unchanged)', async () => {
    host(MAIN);
    expect(await outcome(setSession(tokens))).toBe('ran');
    expect(jar.jar.has('ff_access_token')).toBe(true);
  });

  it('the staff API client refuses outside a cashier action on the cashier host, without any network call', async () => {
    host(CASHIER);
    await expect(apiFetch('/businesses')).rejects.toMatchObject({ status: 404, code: 'WRONG_ORIGIN' });
    expect(fetch).not.toHaveBeenCalled();
    // The same request on the main host is untouched.
    host(MAIN);
    await expect(apiFetch('/businesses')).resolves.toEqual({ ok: true });
  });

  it('inside a cashier action the API client works on the cashier host', async () => {
    host(CASHIER);
    await expect(runInCashierSurface(() => apiFetch('/loyalty/actions/lookup-customer'))).resolves.toEqual({ ok: true });
  });
});
