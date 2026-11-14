import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCookieStore } from './cashier-test-support';

vi.mock('server-only', () => ({}));
const cookieStore = createCookieStore();
vi.mock('next/headers', () => ({ cookies: async () => cookieStore.store }));

import {
  clearCashierSession,
  getCashierContext,
  hasCashierSession,
  setCashierSession,
  setCashierSelectionTicket,
} from './session';
import {
  ACCESS_TOKEN_COOKIE,
  CASHIER_ACCESS_COOKIE,
  CASHIER_CONTEXT_COOKIE,
  CASHIER_REFRESH_COOKIE,
  CASHIER_SELECT_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from '../cookies';

const payload = {
  accessToken: 'a.b.c',
  refreshToken: 'r.s.t',
  session: { businessId: 'biz', branchId: 'br', deviceLabel: 'Counter 1', businessName: 'Cafe', branchName: 'Main' },
};

beforeEach(() => cookieStore.jar.clear());

describe('cashier cookies', () => {
  it('uses its own names, scoped to the cashier path, httpOnly, with the 15-minute / 12-hour lifetimes', async () => {
    await setCashierSession(payload);
    const access = cookieStore.jar.get(CASHIER_ACCESS_COOKIE)!;
    const refresh = cookieStore.jar.get(CASHIER_REFRESH_COOKIE)!;
    expect(access.value).toBe('a.b.c');
    expect(access.options).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/cashier', maxAge: 15 * 60 });
    expect(refresh.options).toMatchObject({ httpOnly: true, path: '/cashier', maxAge: 12 * 60 * 60 });
    expect(await hasCashierSession()).toBe(true);
  });

  it('never reads or writes the staff session cookies', async () => {
    cookieStore.jar.set(ACCESS_TOKEN_COOKIE, { value: 'staff-access' });
    cookieStore.jar.set(REFRESH_TOKEN_COOKIE, { value: 'staff-refresh' });
    await setCashierSession(payload);
    await clearCashierSession();
    expect(cookieStore.jar.get(ACCESS_TOKEN_COOKIE)?.value).toBe('staff-access');
    expect(cookieStore.jar.get(REFRESH_TOKEN_COOKIE)?.value).toBe('staff-refresh');
    expect(await hasCashierSession()).toBe(false);
  });

  it('a cashier session without a staff session reports no staff cookies at all', async () => {
    await setCashierSession(payload);
    expect(cookieStore.jar.has(ACCESS_TOKEN_COOKIE)).toBe(false);
    expect(cookieStore.jar.has(REFRESH_TOKEN_COOKIE)).toBe(false);
  });

  it('reads back the sign-in context, and treats a malformed or edited cookie as no context', async () => {
    await setCashierSession(payload);
    expect(await getCashierContext()).toEqual({ businessId: 'biz', businessName: 'Cafe', branchId: 'br', branchName: 'Main', deviceLabel: 'Counter 1' });
    cookieStore.jar.set(CASHIER_CONTEXT_COOKIE, { value: '{not json' });
    expect(await getCashierContext()).toBeNull();
    cookieStore.jar.set(CASHIER_CONTEXT_COOKIE, { value: JSON.stringify({ businessId: 42 }) });
    expect(await getCashierContext()).toBeNull();
  });

  it('finishing sign-in removes the selection ticket', async () => {
    await setCashierSelectionTicket('ticket');
    expect(cookieStore.jar.has(CASHIER_SELECT_COOKIE)).toBe(true);
    await setCashierSession(payload);
    expect(cookieStore.jar.has(CASHIER_SELECT_COOKIE)).toBe(false);
  });
});
