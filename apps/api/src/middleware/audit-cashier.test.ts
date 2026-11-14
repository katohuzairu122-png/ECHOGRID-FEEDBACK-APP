import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';

/** CASHIER-PWA-01 C7: how the audit middleware marks and records cashier counter activity. */
const m = vi.hoisted(() => ({ record: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: m.close })) }));
vi.mock('../repositories', () => ({ createRepositories: vi.fn(() => ({ auditLog: { record: m.record } })) }));

const { auditTrail } = await import('./audit');
const { AppError } = await import('../lib/errors');
const { errorHandler } = await import('../lib/error-handler');

const USER = '11111111-1111-4111-8111-111111111111';
const BIZ = '22222222-2222-4222-8222-222222222222';
const BR = '33333333-3333-4333-8333-333333333333';

type V = { userId: string; businessId: string; cashier: { businessId: string; branchId: string | null }; auditMetadata: unknown; impersonatedBy: string };
function build(opts: { cashier: boolean; handler: (c: never) => Response | Promise<Response> }) {
  const a = new Hono<{ Bindings: Bindings; Variables: Partial<V> }>();
  a.use('*', auditTrail);
  a.use('*', async (c, next) => {
    c.set('userId', USER);
    c.set('businessId', BIZ);
    if (opts.cashier) c.set('cashier', { businessId: BIZ, branchId: BR });
    await next();
  });
  a.all('/api/v1/*', opts.handler as never);
  a.onError(errorHandler as unknown as Parameters<typeof a.onError>[0]);
  return a;
}
const env = { HYPERDRIVE: { connectionString: 'x' } } as unknown as Bindings;
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;
const call = (a: ReturnType<typeof build>, method: string, path: string) =>
  a.request(path, { method, headers: { 'cf-ray': 'ray-1' } }, env, ctx());
const meta = () => (m.record.mock.calls[0] as unknown as [{ action: string; businessId: string; entityType: string; metadata: Record<string, unknown> }])[0];

beforeEach(() => vi.clearAllMocks());

describe('cashier request recording', () => {
  it('records a verified QR as cashier.qr_verified, marked, branch-stamped and correlated', async () => {
    await call(build({ cashier: true, handler: (c: { json: (b: unknown) => Response }) => c.json({ ok: true }) }), 'POST', '/api/v1/loyalty/actions/resolve-customer');
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(meta()).toMatchObject({ action: 'cashier.qr_verified', businessId: BIZ, metadata: { client: 'cashier', branchId: BR, outcome: 'success', requestId: 'ray-1' } });
  });

  it('records a rejected QR with the error code and status, not the body', async () => {
    const a = build({ cashier: true, handler: () => { throw new AppError('No such QR.', 404, 'CUSTOMER_QR_NOT_FOUND'); } });
    expect((await call(a, 'POST', '/api/v1/loyalty/actions/resolve-customer')).status).toBe(404);
    expect(meta()).toMatchObject({ action: 'cashier.qr_rejected', metadata: { outcome: 'failure', httpStatus: 404, errorCode: 'CUSTOMER_QR_NOT_FOUND' } });
  });

  it('records redemption lookups (an attempt, even a read) and rejected confirmations', async () => {
    await call(build({ cashier: true, handler: (c: { json: (b: unknown) => Response }) => c.json({}) }), 'GET', '/api/v1/loyalty/redemptions/ABC123');
    expect(meta()).toMatchObject({ action: 'cashier.redemption_lookup', metadata: { outcome: 'success' } });
    m.record.mockClear();
    const reject = build({ cashier: true, handler: () => { throw new AppError('Used.', 409, 'REDEMPTION_ALREADY_CONFIRMED'); } });
    await call(reject, 'POST', '/api/v1/loyalty/redemptions/ABC123/confirm');
    expect(meta()).toMatchObject({ action: 'cashier.redemption_rejected', metadata: { outcome: 'failure', errorCode: 'REDEMPTION_ALREADY_CONFIRMED' } });
  });

  it("decorates a handler's own semantic row with the cashier marker instead of duplicating it", async () => {
    const a = build({
      cashier: true,
      handler: (c: { set: (k: string, v: unknown) => void; json: (b: unknown) => Response }) => {
        c.set('auditMetadata', { action: 'loyalty.redemption_confirmed', entityType: 'loyalty_transaction', entityId: 'tx-1' });
        return c.json({});
      },
    });
    await call(a, 'POST', '/api/v1/loyalty/redemptions/ABC123/confirm');
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(meta()).toMatchObject({ action: 'loyalty.redemption_confirmed', entityType: 'loyalty_transaction', metadata: { client: 'cashier', branchId: BR, outcome: 'success' } });
  });

  it('records nothing extra for reads that are not redemption lookups, and nothing for non-cashier requests', async () => {
    await call(build({ cashier: true, handler: (c: { json: (b: unknown) => Response }) => c.json({}) }), 'GET', '/api/v1/auth/me');
    expect(m.record).not.toHaveBeenCalled();
    await call(build({ cashier: false, handler: (c: { json: (b: unknown) => Response }) => c.json({}) }), 'GET', '/api/v1/loyalty/redemptions/ABC123');
    expect(m.record).not.toHaveBeenCalled();
  });

  it('web (non-cashier) mutating rows are unchanged: no cashier marker', async () => {
    await call(build({ cashier: false, handler: (c: { json: (b: unknown) => Response }) => c.json({}) }), 'POST', '/api/v1/loyalty/redemptions/ABC123/confirm');
    expect(meta().metadata ?? {}).not.toHaveProperty('client');
  });

  it('a refused cashier request is recorded as cashier security history', async () => {
    const a = build({ cashier: true, handler: () => { throw new AppError('Forbidden.', 403, 'PERMISSION_DENIED'); } });
    await call(a, 'POST', '/api/v1/loyalty/actions/resolve-customer');
    expect(meta()).toMatchObject({ action: 'security.authorization_failed', metadata: { client: 'cashier', branchId: BR, outcome: 'failure', errorCode: 'PERMISSION_DENIED' } });
  });
});
