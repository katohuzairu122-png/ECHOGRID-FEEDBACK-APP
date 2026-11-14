import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({
  access: vi.fn(),
  refresh: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  }),
}));
vi.mock('next/navigation', () => ({ redirect: m.redirect }));
vi.mock('@/lib/cashier/session', () => ({ getCashierAccessToken: m.access, getCashierRefreshToken: m.refresh }));
vi.mock('./cashier-login-form', () => ({ CashierLoginForm: () => 'FORM' }));

import CashierLoginPage from './page';

const go = (reason?: string) =>
  CashierLoginPage({ searchParams: Promise.resolve(reason ? { reason } : {}) }).then(
    (r) => ({ rendered: r }),
    (e: { digest?: string }) => ({ to: e.digest }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.access.mockResolvedValue(undefined);
  m.refresh.mockResolvedValue(undefined);
});

describe('cashier sign-in page routing (no redirect loops)', () => {
  it('shows the form to a device with no session', async () => {
    expect(await go()).toHaveProperty('rendered');
  });
  it('sends a device with a live access token to the counter', async () => {
    m.access.mockResolvedValue('a');
    m.refresh.mockResolvedValue('r');
    expect(await go()).toEqual({ to: expect.stringContaining('/cashier;') });
  });
  it('sends a device with only a refresh token to the refresh handler', async () => {
    m.refresh.mockResolvedValue('r');
    expect(await go()).toEqual({ to: expect.stringContaining('/cashier/session/refresh') });
  });
  it('after a failed refresh the form is ALWAYS shown, even with cookies still present', async () => {
    m.access.mockResolvedValue('a');
    m.refresh.mockResolvedValue('r');
    expect(await go('session')).toHaveProperty('rendered');
    expect(m.redirect).not.toHaveBeenCalled();
  });
});
