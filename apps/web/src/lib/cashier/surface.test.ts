import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const m = vi.hoisted(() => ({ staff: vi.fn(), cashier: vi.fn(), ctx: vi.fn() }));
vi.mock('../session', () => ({ getAccessToken: m.staff }));
vi.mock('./session', () => ({ getCashierAccessToken: m.cashier, getCashierContext: m.ctx }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));

import { apiFetch } from '../api-client';
import { getActiveBusiness } from '../business';
import { isCashierSurface, runInCashierSurface } from './surface';

beforeEach(() => {
  vi.clearAllMocks();
  m.staff.mockResolvedValue('STAFF');
  m.cashier.mockResolvedValue('CASHIER');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, data: { ok: true } })));
});
const sentAuth = () => new Headers((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).headers).get('Authorization');

describe('credential surface', () => {
  it('outside the cashier surface, apiFetch sends the staff token exactly as before', async () => {
    expect(isCashierSurface()).toBe(false);
    await apiFetch('/branches');
    expect(sentAuth()).toBe('Bearer STAFF');
    expect(m.cashier).not.toHaveBeenCalled();
  });

  it('inside the cashier surface, apiFetch sends the cashier token and never the staff token', async () => {
    await runInCashierSurface(async () => {
      expect(isCashierSurface()).toBe(true);
      await apiFetch('/loyalty/actions/lookup-customer');
    });
    expect(sentAuth()).toBe('Bearer CASHIER');
    expect(m.staff).not.toHaveBeenCalled();
  });

  it('the surface does not leak to concurrent or later work', async () => {
    await runInCashierSurface(async () => undefined);
    expect(isCashierSurface()).toBe(false);
    await apiFetch('/branches');
    expect(sentAuth()).toBe('Bearer STAFF');
  });

  it('the active business in the cashier surface is the bound business from the sign-in context, with no business-list call', async () => {
    m.ctx.mockResolvedValue({ businessId: 'biz-1', businessName: 'Cafe', branchId: null, branchName: null, deviceLabel: null });
    const business = await runInCashierSurface(() => getActiveBusiness());
    expect(business).toMatchObject({ id: 'biz-1', name: 'Cafe' });
    expect(fetch).not.toHaveBeenCalled();
    m.ctx.mockResolvedValue(null);
    expect(await runInCashierSurface(() => getActiveBusiness())).toBeNull();
  });
});
