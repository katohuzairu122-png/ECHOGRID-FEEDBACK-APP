import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';

const h = vi.hoisted(() => ({
  service: { status: vi.fn(), requestCode: vi.fn(), verifyCode: vi.fn() },
  ctor: vi.fn(),
  local: vi.fn(() => 'LOCAL'),
  twilio: vi.fn(() => 'TWILIO'),
}));
vi.mock('../db/client', () => ({ createDb: vi.fn(async () => ({ db: {}, close: async () => {} })) }));
vi.mock('../repositories', () => ({ createRepositories: () => ({ customers: {} }) }));
vi.mock('../repositories/customer-auth-event.repository', () => ({ CustomerAuthEventRepository: class {} }));
vi.mock('../auth/pbkdf2-worker', () => ({ createDurableObjectPbkdf2Worker: () => ({}) }));
vi.mock('./sms.service', () => ({ createSmsService: () => ({}) }));
vi.mock('./twilio-verify.service', () => ({ TwilioVerifyService: class {} }));
vi.mock('./customer-auth.service', () => ({ CustomerAuthService: class {} }));
vi.mock('./customer-phone-attach.service', () => ({
  CustomerPhoneAttachService: class {
    constructor(deps: unknown) { h.ctor(deps); }
    status = h.service.status;
    requestCode = h.service.requestCode;
    verifyCode = h.service.verifyCode;
  },
  createLocalPhoneProof: h.local,
  createTwilioPhoneProof: h.twilio,
}));

import { customerPhoneRoutes } from './customer-phone.routes';
import { errorHandler } from '../lib/error-handler';

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const limit = vi.fn(async (_: { key: string }) => ({ success: true }));
const env = (over: Record<string, unknown> = {}) => ({ OTP_RATE_LIMITER: { limit }, ENVIRONMENT: 'staging', ...over }) as unknown as Bindings;
const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext;

function app() {
  const a = new Hono<{ Bindings: Bindings; Variables: { customerId: string } }>();
  a.onError(errorHandler);
  a.use('*', async (c, next) => { c.set('customerId', CUSTOMER); await next(); });
  a.route('/phone', customerPhoneRoutes);
  return a;
}
const post = (path: string, body: unknown, e = env()) =>
  app().fetch(new Request(`https://api.test/phone${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), e, ctx());

beforeEach(() => {
  vi.clearAllMocks();
  h.service.status.mockResolvedValue({ phoneMasked: null, verified: false });
  h.service.requestCode.mockResolvedValue(undefined);
  h.service.verifyCode.mockResolvedValue({ phoneMasked: '+•••••••4591', verified: true });
});

describe('/loyalty/me/phone routes', () => {
  it('status uses the session customer and is never cached', async () => {
    const response = await app().fetch(new Request('https://api.test/phone'), env(), ctx());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(h.service.status).toHaveBeenCalledWith(CUSTOMER);
    expect(await response.json()).toEqual({ success: true, data: { phoneMasked: null, verified: false } });
  });

  it('request: 204, the customer comes from the session, and the body is strict (no customer id can be supplied)', async () => {
    expect((await post('/request', { phone: '+965 6690 4591' })).status).toBe(204);
    expect(h.service.requestCode).toHaveBeenCalledWith(CUSTOMER, '+965 6690 4591');
    expect((await post('/request', { phone: '+96566904591', customerId: 'someone-else' })).status).toBe(400);
    expect((await post('/request', {})).status).toBe(400);
    expect(h.service.requestCode).toHaveBeenCalledTimes(1);
  });

  it('verify returns the masked status; a client-supplied customer id is rejected', async () => {
    const response = await post('/verify', { phone: '+96566904591', code: '123456' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ success: true, data: { phoneMasked: '+•••••••4591', verified: true } });
    expect(h.service.verifyCode).toHaveBeenCalledWith(CUSTOMER, '+96566904591', '123456');
    expect((await post('/verify', { phone: '+96566904591', code: '123456', customerId: 'x' })).status).toBe(400);
  });

  it('the limiter is keyed by the NORMALIZED number, and a limited request reaches nothing', async () => {
    await post('/request', { phone: ' +965 6690-4591 ' });
    expect(limit).toHaveBeenCalledWith({ key: 'attach:+96566904591' });
    await post('/request', { phone: 'not a number' });
    expect(limit).toHaveBeenLastCalledWith({ key: 'attach:invalid' });
    limit.mockResolvedValueOnce({ success: false });
    h.service.requestCode.mockClear();
    expect((await post('/request', { phone: '+96566904591' })).status).toBe(429);
    expect(h.service.requestCode).not.toHaveBeenCalled();
  });

  it('production proves ownership through Twilio Verify; every other environment uses local codes', async () => {
    await post('/request', { phone: '+96566904591' }, env({ ENVIRONMENT: 'production' }));
    expect(h.twilio).toHaveBeenCalledTimes(1);
    expect(h.local).not.toHaveBeenCalled();
    expect(h.ctor.mock.calls.at(-1)![0]).toMatchObject({ proof: 'TWILIO' });
    h.twilio.mockClear();
    await post('/request', { phone: '+96566904591' }, env({ ENVIRONMENT: 'staging' }));
    expect(h.local).toHaveBeenCalledTimes(1);
    expect(h.twilio).not.toHaveBeenCalled();
  });
});
