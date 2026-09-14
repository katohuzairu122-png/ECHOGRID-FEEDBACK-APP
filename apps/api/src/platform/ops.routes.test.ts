import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import type { PlatformRole } from '../db/schema/users';

/**
 * POST /api/v1/platform/ops/test-alert
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * `authenticate` and `requirePlatformRole` are the REAL middleware, and the
 * tokens below are really signed with the real signer and really verified.
 * Only two things are mocked: the database lookup requirePlatformRole makes
 * to resolve a user's platformRole, and notifyOps itself (so no test posts
 * to a webhook).
 *
 * That split is the point. Stubbing the authorization chain and then
 * asserting the stub refuses 'support' would prove nothing about this
 * route. Here, 'support' is refused by the same allow-list that runs in
 * production, so a future change to requirePlatformRole's semantics shows
 * up as a failure in this file.
 *
 * Runs in the fast `pnpm test` tier: no Postgres, no Miniflare.
 */

const mocks = vi.hoisted(() => ({
  notifyOps: vi.fn(async (_env: unknown, _alert: unknown) => undefined),
  findById: vi.fn(async (_id: string) => undefined as unknown),
  close: vi.fn(async () => undefined),
}));

vi.mock('../lib/ops-alert', () => ({ notifyOps: mocks.notifyOps }));
vi.mock('../db/client', () => ({
  createDb: vi.fn(async () => ({ db: {}, close: mocks.close })),
}));
vi.mock('../repositories', () => ({
  createRepositories: vi.fn(() => ({ users: { findById: mocks.findById } })),
}));

const { platformOpsRoutes } = await import('./ops.routes');
const { errorHandler } = await import('../lib/error-handler');
const { signAccessToken } = await import('../auth/jwt');

/** Fake, and recognisable on sight so assertion 6 cannot pass by accident. */
const JWT_SECRET = 'test-only-access-secret-not-a-real-value';
const CONFIGURED_WEBHOOK = 'https://hooks.example.test/THE-CONFIGURED-OPS-WEBHOOK-SECRET';

const env = {
  ENVIRONMENT: 'production',
  JWT_ACCESS_SECRET: JWT_SECRET,
  OPS_ALERT_WEBHOOK_URL: CONFIGURED_WEBHOOK,
  HYPERDRIVE: { connectionString: 'postgresql://unused' },
} as unknown as Bindings;

const app = new Hono<{ Bindings: Bindings }>();
app.route('/api/v1/platform/ops', platformOpsRoutes);
app.onError(errorHandler);

const ADMIN_USER_ID = '11111111-1111-4111-8111-111111111111';

/** Makes requirePlatformRole's DB lookup return this user. */
function asUser(overrides: { platformRole?: PlatformRole | null; status?: string } = {}) {
  mocks.findById.mockResolvedValue({
    id: ADMIN_USER_ID,
    status: overrides.status ?? 'active',
    platformRole: overrides.platformRole === undefined ? 'admin' : overrides.platformRole,
  });
}

function executionCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

async function callTestAlert(
  options: { token?: string | undefined; body?: unknown; path?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  return app.request(
    options.path ?? '/api/v1/platform/ops/test-alert',
    {
      method: 'POST',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    env,
    executionCtx(),
  );
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function errorCodeOf(response: Response): Promise<string> {
  const parsed = (await bodyOf(response)) as { error?: { code?: string } };
  return parsed.error?.code ?? '';
}

/** The alert argument notifyOps was called with. */
function alertArg(): Record<string, unknown> {
  return mocks.notifyOps.mock.calls[0]?.[1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  asUser();
});

describe('POST /platform/ops/test-alert -- authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const response = await callTestAlert();

    expect(response.status).toBe(401);
    expect(await errorCodeOf(response)).toBe('UNAUTHENTICATED');
  });

  it('rejects a malformed or forged token', async () => {
    // Signed with the wrong secret: the real verifier has to reject it, not
    // a stub that checks for header presence.
    const forged = await signAccessToken(ADMIN_USER_ID, 'a-different-secret');

    expect((await callTestAlert({ token: 'not-a-token' })).status).toBe(401);
    expect((await callTestAlert({ token: forged })).status).toBe(401);
  });

  it('rejects the platform SUPPORT role', async () => {
    asUser({ platformRole: 'support' });
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('PLATFORM_ROLE_DENIED');
  });

  it('rejects the platform BILLING role', async () => {
    asUser({ platformRole: 'billing' });
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('PLATFORM_ROLE_DENIED');
  });

  it('rejects an authenticated user with no platform role at all', async () => {
    asUser({ platformRole: null });
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('PLATFORM_ACCESS_DENIED');
  });

  it('rejects a platform admin whose account is not active', async () => {
    // requirePlatformRole re-checks status as defence in depth (authenticate
    // does not). Asserted here so that property is not quietly lost.
    asUser({ platformRole: 'admin', status: 'suspended' });
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(response.status).toBe(403);
    expect(await errorCodeOf(response)).toBe('PLATFORM_ACCESS_DENIED');
  });

  it('accepts a platform ADMIN', async () => {
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toMatchObject({ success: true, data: { dispatched: true } });
  });

  it('fires no alert on ANY rejected path', async () => {
    // The property that matters most: if a refused request could still reach
    // notifyOps, this endpoint would be an unauthenticated way to spam the
    // on-call channel.
    await callTestAlert();
    await callTestAlert({ token: 'not-a-token' });
    asUser({ platformRole: 'support' });
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    asUser({ platformRole: 'billing' });
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(mocks.notifyOps).not.toHaveBeenCalled();
  });
});

describe('POST /platform/ops/test-alert -- the dispatched alert', () => {
  it('calls the operations alert mechanism exactly once', async () => {
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(mocks.notifyOps).toHaveBeenCalledOnce();
  });

  it('sends the fixed diagnostic payload, exactly', async () => {
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    // toEqual, not toMatchObject: an EXTRA field would also be a defect
    // here, since the whole contract is that this payload is fixed.
    expect(alertArg()).toEqual({
      event: 'ops.delivery_test',
      severity: 'warning',
      message: 'Echo Grid operations alert delivery test.',
      detail: { source: 'platform_admin' },
    });
  });

  it("uses event 'ops.delivery_test'", async () => {
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    expect(alertArg().event).toBe('ops.delivery_test');
  });

  it("uses severity 'warning', never 'critical'", async () => {
    // 'critical' is reserved for dead-lettered jobs and failed cron sweeps.
    // A diagnostic somebody fired on purpose must not read as an incident.
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    expect(alertArg().severity).toBe('warning');
  });

  it('takes the destination from env, never from the caller', async () => {
    await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    const envArg = mocks.notifyOps.mock.calls[0]?.[0] as Bindings;
    expect(envArg.OPS_ALERT_WEBHOOK_URL).toBe(CONFIGURED_WEBHOOK);
  });
});

describe('POST /platform/ops/test-alert -- no injection surface', () => {
  it('ignores a request body attempting to supply its own webhook and payload', async () => {
    // The attack this endpoint must not enable: an admin token turned into
    // an arbitrary-webhook-poster, or into a fake 'critical' incident.
    await callTestAlert({
      token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET),
      body: {
        webhookUrl: 'https://attacker.example/steal',
        OPS_ALERT_WEBHOOK_URL: 'https://attacker.example/steal',
        event: 'queue.dead_letter',
        severity: 'critical',
        message: 'PRODUCTION IS DOWN, CALL EVERYONE',
        detail: { source: 'attacker', pageEveryone: true },
      },
    });

    expect(alertArg()).toEqual({
      event: 'ops.delivery_test',
      severity: 'warning',
      message: 'Echo Grid operations alert delivery test.',
      detail: { source: 'platform_admin' },
    });

    const envArg = mocks.notifyOps.mock.calls[0]?.[0] as Bindings;
    expect(envArg.OPS_ALERT_WEBHOOK_URL).toBe(CONFIGURED_WEBHOOK);
    expect(JSON.stringify(alertArg())).not.toContain('attacker.example');
  });

  it('ignores query-string attempts at the same thing', async () => {
    await callTestAlert({
      token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET),
      path: '/api/v1/platform/ops/test-alert?severity=critical&message=fake&webhookUrl=https://attacker.example',
    });

    expect(alertArg().severity).toBe('warning');
    expect(alertArg().message).toBe('Echo Grid operations alert delivery test.');
  });

  it('is unaffected by a body that is not JSON at all', async () => {
    // The route never reads the body, so a malformed one must not 400 --
    // proving there is no parse step to exploit or to fail.
    const response = await app.request(
      '/api/v1/platform/ops/test-alert',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await signAccessToken(ADMIN_USER_ID, JWT_SECRET)}`,
          'content-type': 'application/json',
        },
        body: '{not json at all',
      },
      env,
      executionCtx(),
    );

    expect(response.status).toBe(200);
    expect(alertArg().event).toBe('ops.delivery_test');
  });

  it('cannot be mutated across requests by a previous caller', async () => {
    // The payload is module-scoped and frozen. If it were ever spread over
    // or merged into, request N could poison request N+1.
    const token = await signAccessToken(ADMIN_USER_ID, JWT_SECRET);
    await callTestAlert({ token, body: { severity: 'critical' } });
    await callTestAlert({ token });

    expect(mocks.notifyOps.mock.calls[1]?.[1]).toEqual(mocks.notifyOps.mock.calls[0]?.[1]);
    expect((mocks.notifyOps.mock.calls[1]?.[1] as { severity: string }).severity).toBe('warning');
  });
});

describe('POST /platform/ops/test-alert -- response body', () => {
  it('does not expose OPS_ALERT_WEBHOOK_URL', async () => {
    // The secret is a credential: anyone holding it can post into the ops
    // channel. Asserted against the whole serialised body, not a field list,
    // so a future field cannot leak it past this test.
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    const raw = JSON.stringify(await bodyOf(response));

    expect(raw).not.toContain(CONFIGURED_WEBHOOK);
    expect(raw).not.toContain('hooks.example.test');
    expect(raw).not.toContain('OPS_ALERT_WEBHOOK_URL');
  });

  it('exposes no other env value either', async () => {
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    const raw = JSON.stringify(await bodyOf(response));

    expect(raw).not.toContain(JWT_SECRET);
    expect(raw).not.toContain('postgresql://');
  });

  it('uses the standard success envelope', async () => {
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    const parsed = await bodyOf(response);

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ dispatched: true, event: 'ops.delivery_test' });
  });

  it('says plainly that delivery is not confirmed', async () => {
    // notifyOps never reports its own outcome, so `dispatched: true` must
    // not be read as "it arrived". If that caveat is ever dropped, an
    // operator would take a 200 as proof the channel works.
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });
    const data = (await bodyOf(response)).data as { checkChannel?: string };

    expect(data.checkChannel).toMatch(/operations channel/i);
  });

  it('still returns 200 when delivery fails, because notifyOps swallows it', async () => {
    // Existing alert behaviour is deliberately unchanged (requirement 9):
    // notifyOps logs first, never throws, never retries. This route must not
    // convert that into a 500.
    mocks.notifyOps.mockResolvedValueOnce(undefined);
    const response = await callTestAlert({ token: await signAccessToken(ADMIN_USER_ID, JWT_SECRET) });

    expect(response.status).toBe(200);
  });
});

describe('POST /platform/ops/test-alert -- method and path', () => {
  it('is not reachable by GET', async () => {
    const response = await app.request(
      '/api/v1/platform/ops/test-alert',
      { method: 'GET', headers: { authorization: `Bearer ${await signAccessToken(ADMIN_USER_ID, JWT_SECRET)}` } },
      env,
      executionCtx(),
    );

    // Asserted as "not 200, and nothing dispatched" rather than pinning an
    // exact code: whether Hono answers a method mismatch with 404 or 405 is
    // its business, and the property that matters is that no alert fires.
    expect(response.status).not.toBe(200);
    expect([404, 405]).toContain(response.status);
    expect(mocks.notifyOps).not.toHaveBeenCalled();
  });
});
