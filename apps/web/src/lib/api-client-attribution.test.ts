import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('next/headers', () => ({ headers: async () => ({ get: (k: string) => h.map.get(k) ?? null }) }));
vi.mock('./session', () => ({ getAccessToken: vi.fn(async () => 'staff-token') }));
vi.mock('./cashier/session', () => ({ getCashierAccessToken: vi.fn(async () => 'cashier-token') }));
vi.mock('./cashier/host-guard', () => ({ onCashierHost: vi.fn(async () => false) }));

import { apiFetch } from './api-client';
import { runInCashierSurface } from './cashier/surface';

/** SEC-CASHIER-POST-R2 C1: cashier API calls carry the signed real client; staff calls never do. */
describe('apiFetch client attribution', () => {
  const calls: Headers[] = [];
  beforeEach(() => {
    calls.length = 0;
    h.map.set('cf-connecting-ip', '203.0.113.7');
    h.map.set('user-agent', 'Pixel 7');
    process.env.CLIENT_ATTRIBUTION_SECRET = 's3cret';
    vi.stubGlobal('fetch', vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(new Headers(init?.headers));
      return Response.json({ success: true, data: {} });
    }));
  });
  afterEach(() => {
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
  });

  it('signs a cashier-surface call', async () => {
    await runInCashierSurface(() => apiFetch('/loyalty/redemptions/ABC'));
    expect(calls[0]!.get('x-echo-client')).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(calls[0]!.get('Authorization')).toBe('Bearer cashier-token');
  });
  it('never signs a staff call', async () => {
    await apiFetch('/branches');
    expect(calls[0]!.get('x-echo-client')).toBeNull();
  });
  it('sends nothing when the secret is not configured', async () => {
    delete process.env.CLIENT_ATTRIBUTION_SECRET;
    await runInCashierSurface(() => apiFetch('/loyalty/redemptions/ABC'));
    expect(calls[0]!.get('x-echo-client')).toBeNull();
  });
  it('does not let a caller-supplied header override the signed one', async () => {
    await runInCashierSurface(() => apiFetch('/x', { headers: { 'x-echo-client': 'v1.forged.forged' } }));
    expect(calls[0]!.get('x-echo-client')).not.toBe('v1.forged.forged');
  });
});
