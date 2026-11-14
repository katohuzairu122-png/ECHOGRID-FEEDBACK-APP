import { describe, it, expect, vi } from 'vitest';
import { sign } from 'hono/jwt';
import {
  CASHIER_ALLOWED_ROUTES,
  isCashierRouteAllowed,
  peekScopeClaims,
  toApiPath,
} from './cashier-scope';

// Importing the real application for the route-introspection test needs the same stand-ins the other
// application-level tests use; no request is ever served here.
vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: async () => {} })),
}));
vi.mock('../repositories', () => ({ createRepositories: () => ({}) }));
vi.mock('./rate-limit', () => ({
  rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  rateLimitByCustomer: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('./audit', () => ({
  auditTrail: async (_c: unknown, next: () => Promise<void>) => next(),
}));

const { listRegisteredRoutes } = await import('../index');

const EXPECTED_ALLOWED = [
  'GET /api/v1/auth/me',
  'GET /api/v1/businesses/me',
  'GET /api/v1/loyalty/redemptions/:code',
  'POST /api/v1/loyalty/accounts/:id/purchase',
  'POST /api/v1/loyalty/actions/lookup-customer',
  'POST /api/v1/loyalty/actions/lookup-purchase',
  'POST /api/v1/loyalty/actions/resolve-customer',
  'POST /api/v1/loyalty/redemptions/:code/confirm',
].sort();

describe('cashier route allow-list (exact, default deny)', () => {
  it('has exactly the eight counter routes', () => {
    expect(CASHIER_ALLOWED_ROUTES.map((r) => r.label).sort()).toEqual(
      EXPECTED_ALLOWED.map((s) => s.replace('/api/v1', '')).sort(),
    );
  });

  it('accepts each listed method and path', () => {
    expect(isCashierRouteAllowed('POST', '/loyalty/actions/lookup-customer')).toBe(true);
    expect(isCashierRouteAllowed('POST', '/loyalty/accounts/abc-123/purchase')).toBe(true);
    expect(isCashierRouteAllowed('GET', '/loyalty/redemptions/CODE1')).toBe(true);
    expect(isCashierRouteAllowed('POST', '/loyalty/redemptions/CODE1/confirm')).toBe(true);
    expect(isCashierRouteAllowed('GET', '/businesses/me')).toBe(true);
    expect(isCashierRouteAllowed('GET', '/auth/me')).toBe(true);
  });

  it('refuses a wrong method on a listed path (including HEAD, PUT, PATCH, DELETE, OPTIONS)', () => {
    for (const m of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      expect(isCashierRouteAllowed(m, '/businesses/me')).toBe(false);
      expect(isCashierRouteAllowed(m, '/loyalty/accounts/x/purchase')).toBe(false);
    }
    expect(isCashierRouteAllowed('GET', '/loyalty/actions/lookup-customer')).toBe(false);
    expect(isCashierRouteAllowed('POST', '/businesses/me')).toBe(false);
    expect(isCashierRouteAllowed('POST', '/loyalty/redemptions/CODE1')).toBe(false);
    expect(isCashierRouteAllowed('GET', '/loyalty/redemptions/CODE1/confirm')).toBe(false);
  });

  it('refuses near-miss paths: trailing slash, extra or missing segments, case, administrative lookalikes', () => {
    for (const p of [
      '/businesses/me/',
      '/businesses/me/team',
      '/businesses',
      '/Businesses/me',
      '/loyalty/accounts/x/purchase/',
      '/loyalty/accounts/x/adjust',
      '/loyalty/accounts/x',
      '/loyalty/accounts//purchase',
      '/loyalty/accounts/x/y/purchase',
      '/loyalty/redemptions',
      '/loyalty/redemptions/a/b/confirm',
      '/loyalty/actions/lookup-customer/extra',
      '/loyalty/settings',
      '/loyalty/tiers',
      '/loyalty/rewards',
      '/loyalty/rewards/x/dashboard',
      '/billing/subscription',
      '/billing/checkout',
      '/team',
      '/team/invite',
      '/branches',
      '/settlements',
      '/analytics/summary',
      '/platform/businesses',
      '/platform/customers',
      '/internal/stripe-read/anything',
      '/auth/refresh',
      '/auth/logout',
      '/auth/password/change',
      '/surveys',
      '',
      '/',
    ]) {
      expect(isCashierRouteAllowed('GET', p), `GET ${p}`).toBe(false);
      expect(isCashierRouteAllowed('POST', p), `POST ${p}`).toBe(false);
    }
  });

  it('toApiPath strips only the /api/v1 prefix', () => {
    expect(toApiPath('/api/v1/auth/me')).toBe('/auth/me');
    expect(toApiPath('/auth/me')).toBeNull();
    expect(toApiPath('/api/v1')).toBeNull();
    expect(toApiPath('/api/v2/auth/me')).toBeNull();
  });
});

describe('scope claim peek (decides only to restrict more, never to grant)', () => {
  const jwt = (payload: Record<string, unknown>) => sign(payload, 'any-secret', 'HS256');

  it('reports a scope when client, bid or brid is present, whatever the value', async () => {
    expect(
      peekScopeClaims(`Bearer ${await jwt({ sub: 'u', client: 'cashier', bid: 'b' })}`),
    ).toEqual({ client: 'cashier' });
    expect(peekScopeClaims(`Bearer ${await jwt({ sub: 'u', client: 'kiosk' })}`)).toEqual({
      client: 'kiosk',
    });
    expect(peekScopeClaims(`Bearer ${await jwt({ sub: 'u', bid: 'b' })}`)).toEqual({
      client: undefined,
    });
    expect(peekScopeClaims(`Bearer ${await jwt({ sub: 'u', brid: 'b' })}`)).toEqual({
      client: undefined,
    });
  });

  it('reports nothing for ordinary, absent, malformed or non-bearer tokens', async () => {
    expect(peekScopeClaims(`Bearer ${await jwt({ sub: 'u', type: 'access' })}`)).toBeUndefined();
    expect(peekScopeClaims(undefined)).toBeUndefined();
    expect(peekScopeClaims('Bearer not-a-jwt')).toBeUndefined();
    expect(peekScopeClaims('Bearer a.!!!.c')).toBeUndefined();
    expect(peekScopeClaims(`Basic ${await jwt({ client: 'cashier' })}`)).toBeUndefined();
    expect(peekScopeClaims('Bearer a.e30.c')).toBeUndefined(); // payload "{}"
    expect(peekScopeClaims('Bearer a.W10.c')).toBeUndefined(); // payload "[]"
  });
});

describe('route introspection: no registered route is reachable by a cashier token unless listed', () => {
  const routes = listRegisteredRoutes().filter(
    (r) => r.method !== 'ALL' && r.path.startsWith('/api/v1/'),
  );

  it('finds the registered API routes', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.some((r) => r.path.startsWith('/api/v1/platform/'))).toBe(true);
    expect(routes.some((r) => r.path.startsWith('/api/v1/billing'))).toBe(true);
  });

  it('allows exactly the eight listed routes and nothing else', () => {
    const allowed = routes
      .filter((r) =>
        isCashierRouteAllowed(
          r.method,
          toApiPath(r.path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, 'x')) ?? '',
        ),
      )
      .map((r) => `${r.method} ${r.path}`);
    expect([...new Set(allowed)].sort()).toEqual(EXPECTED_ALLOWED);
  });

  it('every listed route exists (a typo in the allow-list would otherwise go unnoticed)', () => {
    const registered = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const entry of EXPECTED_ALLOWED) expect(registered.has(entry), entry).toBe(true);
  });

  it('denies every platform, billing, team, settlement, analytics and internal route', () => {
    for (const r of routes) {
      if (
        /^\/api\/v1\/(platform|billing|team|settlements|analytics|internal|orphan-settlements|notifications)(\/|$)/.test(
          r.path,
        )
      ) {
        const sample = r.path.replace(/:[A-Za-z0-9_]+(\{[^}]*\})?/g, 'x');
        expect(
          isCashierRouteAllowed(r.method, toApiPath(sample) ?? ''),
          `${r.method} ${r.path}`,
        ).toBe(false);
      }
    }
  });
});
