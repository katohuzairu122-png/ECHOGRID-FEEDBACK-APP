import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sign } from 'hono/jwt';
import type { Bindings } from '../config/env';
import { errorHandler } from '../lib/error-handler';
import { CUSTOMER_SESSION_ACCESS_TOKEN_TYPE } from '../customer-auth/session-tokens';
import { createFlagAwareCustomerAuthenticate } from './customer-authenticate';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const now = Math.floor(Date.now() / 1000);
const sessionToken = () => sign({ type: CUSTOMER_SESSION_ACCESS_TOKEN_TYPE, sub: CUSTOMER, iat: now, exp: now + 900 }, 'any-key', 'HS256');
const legacyToken = () => sign({ type: 'customer_access', sub: CUSTOMER, iat: now, exp: now + 900 }, 'any-key', 'HS256');
const unknownToken = () => sign({ type: 'something_else', sub: CUSTOMER }, 'any-key', 'HS256');

function build(options: {
  enabled: boolean;
  open: () => Promise<{ sessions: unknown; close(): Promise<void> } | null>;
  events?: string[];
}) {
  const events: string[] = options.events ?? [];
  const app = new Hono<{ Bindings: Bindings }>();
  app.onError(errorHandler);
  app.get(
    '/me',
    createFlagAwareCustomerAuthenticate({ isEnabled: () => options.enabled, open: options.open as never }),
    (c) => {
      events.push('handler');
      return c.json({ customerId: c.get('customerId') });
    },
  );
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
  const get = (token?: string) =>
    app.fetch(new Request('https://api.test/me', { headers: token ? { Authorization: `Bearer ${token}` } : {} }), {} as Bindings, ctx);
  return { get, events, ctx };
}

function sessions(over: Partial<{ session: unknown; legacy: unknown }> = {}) {
  return {
    authenticateSessionToken: vi.fn(async () => (over.session === undefined ? { assurance: 'session', customerId: CUSTOMER } : over.session)),
    authenticateLegacyToken: vi.fn(async () => (over.legacy === undefined ? { assurance: 'legacy', customerId: CUSTOMER } : over.legacy)),
  };
}

describe('flag-aware customer authentication (S5-02)', () => {
  it('flag OFF: the rotating service is never opened and behaviour is the legacy middleware', async () => {
    const open = vi.fn();
    const { get } = build({ enabled: false, open });
    expect((await get()).status).toBe(401); // legacy: missing header
    expect(open).not.toHaveBeenCalled();
  });

  it('flag ON but the configuration is unusable (opener returns null or throws): legacy behaviour, never a lockout path', async () => {
    for (const open of [async () => null, async () => { throw new Error('boom'); }]) {
      const { get } = build({ enabled: true, open });
      const response = await get(await sessionToken()); // no rotating session can exist: legacy rejects it
      expect(response.status).toBe(401);
    }
  });

  it('a rotating session token is verified by the session service, not the legacy verifier', async () => {
    const s = sessions();
    const close = vi.fn(async () => {});
    const { get } = build({ enabled: true, open: async () => ({ sessions: s, close }) });
    const response = await get(await sessionToken());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customerId: CUSTOMER });
    expect(s.authenticateSessionToken).toHaveBeenCalledTimes(1);
    expect(s.authenticateLegacyToken).not.toHaveBeenCalled();
  });

  it('a legacy 90-day token is verified by the legacy rules of the session service (existing customers keep working)', async () => {
    const s = sessions();
    const { get } = build({ enabled: true, open: async () => ({ sessions: s, close: async () => {} }) });
    expect((await get(await legacyToken())).status).toBe(200);
    expect(s.authenticateLegacyToken).toHaveBeenCalledTimes(1);
    expect(s.authenticateSessionToken).not.toHaveBeenCalled();
  });

  it('a revoked session, a suspended customer or a legacy token past its cutoff is one generic 401 and the handler never runs', async () => {
    for (const [token, over] of [
      [await sessionToken(), { session: null }],
      [await legacyToken(), { legacy: null }],
    ] as const) {
      const { get, events } = build({ enabled: true, open: async () => ({ sessions: sessions(over), close: async () => {} }) });
      const response = await get(token);
      expect(response.status).toBe(401);
      expect(await response.text()).toContain('UNAUTHENTICATED');
      expect(events).not.toContain('handler');
    }
  });

  it('missing, malformed and unknown-type bearers are refused without calling any verifier', async () => {
    const s = sessions();
    const { get } = build({ enabled: true, open: async () => ({ sessions: s, close: async () => {} }) });
    expect((await get()).status).toBe(401);
    expect((await get('not-a-jwt')).status).toBe(401);
    expect((await get(await unknownToken())).status).toBe(401);
    expect(s.authenticateSessionToken).not.toHaveBeenCalled();
    expect(s.authenticateLegacyToken).not.toHaveBeenCalled();
  });

  it('closes the database connection BEFORE the route handler runs (no second connection held open)', async () => {
    const events: string[] = [];
    const close = vi.fn(async () => { events.push('close'); });
    const { get } = build({ enabled: true, events, open: async () => ({ sessions: sessions(), close }) });
    expect((await get(await sessionToken())).status).toBe(200);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['close', 'handler']);
  });

  it('a verifier failure still releases the connection and does not authenticate', async () => {
    const close = vi.fn(async () => {});
    const s = { authenticateSessionToken: vi.fn(async () => { throw new Error('db down'); }), authenticateLegacyToken: vi.fn() };
    const { get, events } = build({ enabled: true, open: async () => ({ sessions: s, close }) });
    const response = await get(await sessionToken());
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(close).toHaveBeenCalledTimes(1);
    expect(events).not.toContain('handler');
  });
});
