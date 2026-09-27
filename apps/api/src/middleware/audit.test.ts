import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { AuthVariables } from './authenticate';
import type { TenantVariables } from './tenant-context';

const mocks = vi.hoisted(() => ({
  record: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
}));

vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({ auditLog: { record: mocks.record } })),
}));

const { auditTrail } = await import('./audit');
const { AppError } = await import('../lib/errors');
const { errorHandler } = await import('../lib/error-handler');

const app = new Hono<{
  Bindings: Bindings;
  Variables: Partial<AuthVariables> & Partial<TenantVariables>;
}>();
app.use('*', auditTrail);
app.post('/login', () => {
  throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
});
app.post('/forbidden', (c) => {
  c.set('userId', '11111111-1111-4111-8111-111111111111');
  c.set('businessId', '22222222-2222-4222-8222-222222222222');
  throw new AppError('Forbidden.', 403, 'FORBIDDEN');
});
app.post('/invalid', () => {
  throw new AppError('Invalid input.', 422, 'VALIDATION_ERROR');
});
app.onError(errorHandler as unknown as Parameters<typeof app.onError>[0]);

const env = { HYPERDRIVE: { connectionString: 'postgresql://unused' } } as unknown as Bindings;

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

describe('auditTrail security events', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a credential-free authentication failure and preserves the 401 response', async () => {
    const response = await app.request(
      '/login',
      {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '203.0.113.10',
          'user-agent': 'test-agent',
        },
        body: JSON.stringify({ email: 'person@example.test', password: 'never-log-this' }),
      },
      env,
      executionCtx(),
    );

    expect(response.status).toBe(401);
    expect(mocks.record).toHaveBeenCalledWith({
      businessId: null,
      actorUserId: null,
      action: 'security.authentication_failed',
      entityType: 'security_event',
      entityId: null,
      metadata: { method: 'POST', path: '/login', errorCode: 'INVALID_CREDENTIALS' },
      ipAddress: '203.0.113.10',
      userAgent: 'test-agent',
    });
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain('never-log-this');
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain('person@example.test');
  });

  it('attributes an authorization failure to the authenticated user and business', async () => {
    expect((await app.request('/forbidden', { method: 'POST' }, env, executionCtx())).status).toBe(
      403,
    );

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: '11111111-1111-4111-8111-111111111111',
        businessId: '22222222-2222-4222-8222-222222222222',
        action: 'security.authorization_failed',
      }),
    );
  });

  it('does not persist ordinary validation failures as security events', async () => {
    expect((await app.request('/invalid', { method: 'POST' }, env, executionCtx())).status).toBe(
      422,
    );
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

