import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { signClientAttribution } from '../lib/client-attribution';

/** SEC-CASHIER-POST-R2 C1: audit rows record the SIGNED real client, never an unsigned/forged/stale claim. */
const m = vi.hoisted(() => ({ record: vi.fn(async () => undefined) }));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => undefined })) }));
vi.mock('../repositories', () => ({ createRepositories: vi.fn(() => ({ auditLog: { record: m.record } })) }));
const { auditTrail } = await import('./audit');
const { AppError } = await import('../lib/errors');
const { errorHandler } = await import('../lib/error-handler');

const SECRET = 'attribution-secret-for-tests';
const USER = '11111111-1111-4111-8111-111111111111';
const BIZ = '22222222-2222-4222-8222-222222222222';
const EGRESS = '198.51.100.250';
const CLIENT_IP = '203.0.113.7';

type V = { userId: string; businessId: string; cashier: { businessId: string; branchId: string | null }; auditMetadata: unknown };
function build(handler: (c: never) => Response | Promise<Response>, cashier = true) {
  const a = new Hono<{ Bindings: Bindings; Variables: Partial<V> }>();
  a.use('*', auditTrail);
  a.use('*', async (c, next) => {
    c.set('userId', USER);
    c.set('businessId', BIZ);
    if (cashier) c.set('cashier', { businessId: BIZ, branchId: null });
    await next();
  });
  a.all('/api/v1/*', handler as never);
  a.onError(errorHandler as unknown as Parameters<typeof a.onError>[0]);
  return a;
}
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const envWith = (secret?: string) => ({ HYPERDRIVE: { connectionString: 'x' }, ...(secret ? { CLIENT_ATTRIBUTION_SECRET: secret } : {}) }) as unknown as Bindings;
const row = () => (m.record.mock.calls[0] as unknown as [{ ipAddress: string | null; userAgent: string | null; metadata: Record<string, unknown> }])[0];
const edge = { 'cf-connecting-ip': EGRESS, 'user-agent': 'web-worker/1', 'cf-ray': 'r1' };
const signed = async (ts = Date.now()) => ({ 'x-echo-client': await signClientAttribution(SECRET, { ip: CLIENT_IP, userAgent: 'Pixel 7 Chrome' }, ts) });
const ok = (c: { json: (b: unknown) => Response }) => c.json({ ok: true });
const send = (a: ReturnType<typeof build>, headers: Record<string, string>, env: Bindings, path = '/api/v1/loyalty/actions/resolve-customer') =>
  a.request(path, { method: 'POST', headers }, env, ctx());

beforeEach(() => vi.clearAllMocks());

describe('audit forensic attribution (C1)', () => {
  it('records the signed client IP and user agent on a cashier request row, marked ipSource=signed', async () => {
    await send(build(ok), { ...edge, ...(await signed()) }, envWith(SECRET));
    expect(row()).toMatchObject({ ipAddress: CLIENT_IP, userAgent: 'Pixel 7 Chrome', metadata: { client: 'cashier', ipSource: 'signed' } });
  });
  it('records the signed client on a security-failure row (401/403)', async () => {
    const a = build(() => { throw new AppError('Denied', 403, 'CASHIER_ROUTE_DENIED'); });
    await send(a, { ...edge, ...(await signed()) }, envWith(SECRET));
    expect(row()).toMatchObject({ ipAddress: CLIENT_IP, userAgent: 'Pixel 7 Chrome', metadata: { errorCode: 'CASHIER_ROUTE_DENIED', ipSource: 'signed' } });
  });
  it('records the signed client on the handler-decorated success row', async () => {
    const a = build((c: { set: (k: string, v: unknown) => void; json: (b: unknown) => Response }) => {
      c.set('auditMetadata', { action: 'loyalty.purchase_recorded', entityType: 'loyalty_transaction' });
      return c.json({});
    });
    await send(a, { ...edge, ...(await signed()) }, envWith(SECRET), '/api/v1/loyalty/accounts/x/purchase');
    expect(row()).toMatchObject({ ipAddress: CLIENT_IP, userAgent: 'Pixel 7 Chrome', metadata: { client: 'cashier', ipSource: 'signed' } });
  });
  it('keeps the edge values for a forged, wrong-secret, stale or malformed header', async () => {
    const forged = { 'x-echo-client': 'v1.eyJpcCI6IjEuMS4xLjEifQ.AAAA' };
    const wrongSecret = { 'x-echo-client': await signClientAttribution('another-secret', { ip: CLIENT_IP, userAgent: 'x' }, Date.now()) };
    const stale = await signed(Date.now() - 120_000);
    for (const headers of [forged, wrongSecret, stale, { 'x-echo-client': 'garbage' }]) {
      m.record.mockClear();
      await send(build(ok), { ...edge, ...headers }, envWith(SECRET));
      expect(row()).toMatchObject({ ipAddress: EGRESS, userAgent: 'web-worker/1' });
      expect(row().metadata.ipSource).toBeUndefined();
    }
  });
  it('ignores a signed header when no secret is configured (previous behaviour)', async () => {
    await send(build(ok), { ...edge, ...(await signed()) }, envWith());
    expect(row()).toMatchObject({ ipAddress: EGRESS, userAgent: 'web-worker/1' });
  });
  it('attributes a non-cashier (staff) row to the signed client too, without adding a marker', async () => {
    const a = build((c: { set: (k: string, v: unknown) => void; json: (b: unknown) => Response }) => {
      c.set('auditMetadata', { action: 'branch.updated', entityType: 'branch', details: { x: 1 } });
      return c.json({});
    }, false);
    await send(a, { ...edge, ...(await signed()) }, envWith(SECRET), '/api/v1/branches/b1');
    expect(row()).toMatchObject({ ipAddress: CLIENT_IP, metadata: { x: 1 } });
    expect(row().metadata.client).toBeUndefined();
  });
});
