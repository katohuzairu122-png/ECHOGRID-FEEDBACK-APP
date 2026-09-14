import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Bindings } from '../config/env';

/**
 * The Stripe webhook's signature check (audit P0-4).
 *
 * WHY THIS IS THE HIGHEST-VALUE TEST ON THIS ROUTE
 * This endpoint is mounted outside the entire /api/v1 middleware stack: no
 * JWT, no CORS, no rate limit, by design (see the route's own doc comment).
 * `constructEventAsync` is therefore not one control among several -- it is
 * the ONLY thing standing between the public internet and
 * StripeWebhookService, which flips subscription status and entitlements.
 * If it ever silently stopped verifying, nothing else in the request path
 * would notice, and the failure would look exactly like success.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT
 * The Stripe SDK and the signature verification are REAL -- signatures below
 * are computed with WebCrypto exactly as Stripe computes them, so these
 * exercise the true cryptographic path rather than a stub that always says
 * yes. Only what lies BEYOND verification is mocked (the database and the
 * event-processing service), because the question under test is whether a
 * request gets that far, not what happens once it does.
 *
 * These run in the fast `pnpm test` tier: every rejection path returns
 * before createDb() is reached, and the accepted path is asserted against a
 * mocked service, so no Postgres and no Miniflare are needed.
 */

const mocks = vi.hoisted(() => ({
  processEvent: vi.fn(async (_event: unknown) => undefined),
  createDb: vi.fn(async () => ({ db: {}, close: vi.fn(async () => undefined) })),
}));

vi.mock('../db/client', () => ({ createDb: mocks.createDb }));
vi.mock('../repositories', () => ({ createRepositories: vi.fn(() => ({})) }));
vi.mock('./stripe-webhook.service', () => ({
  StripeWebhookService: vi.fn(() => ({ processEvent: mocks.processEvent })),
}));

const { stripeWebhookRoutes } = await import('./stripe-webhook.routes');
const { errorHandler } = await import('../lib/error-handler');

/**
 * Fake values, never real credentials. The secret only has to be the same
 * string on both sides of an HMAC; it is not checked against Stripe, and no
 * network call happens in this file. STRIPE_SECRET_KEY is never used on any
 * path these tests reach -- constructing the client does no I/O.
 */
const WEBHOOK_SECRET = 'whsec_test_fake_value_used_only_by_this_test_file';
const SECRET_KEY = 'sk_test_fake_value_used_only_by_this_test_file';

const env = {
  ENVIRONMENT: 'development',
  STRIPE_SECRET_KEY: SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://unused' },
} as unknown as Bindings;

function executionCtx(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  } as unknown as ExecutionContext;
}

const app = new Hono<{ Bindings: Bindings }>();
app.route('/webhooks/stripe', stripeWebhookRoutes);
app.onError(errorHandler);

/**
 * Stripe's documented scheme: `t=<unix seconds>,v1=<hex HMAC-SHA256 over
 * "<t>.<payload>" keyed by the whole webhook secret string>`. Written out by
 * hand rather than via stripe.webhooks.generateTestHeaderString() on
 * purpose -- a helper from the same library that does the verifying could
 * agree with a broken implementation. This agrees with the published wire
 * format.
 */
async function signPayload(
  payload: string,
  secret: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestampSeconds}.${payload}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `t=${timestampSeconds},v1=${hex}`;
}

/** A minimally-shaped real Stripe event body. The route only forwards it. */
function eventPayload(id = 'evt_test_1'): string {
  return JSON.stringify({
    id,
    object: 'event',
    api_version: '2026-05-27.dahlia',
    created: Math.floor(Date.now() / 1000),
    type: 'customer.subscription.updated',
    data: { object: { id: 'sub_test_1', object: 'subscription', status: 'active' } },
  });
}

// `async`, not a plain function returning the call directly: Hono types
// app.request() as `Response | Promise<Response>` (it resolves synchronously
// when no handler in the chain is async), and an async function normalises
// either into the Promise<Response> every caller here awaits.
async function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(
    '/webhooks/stripe',
    { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } },
    env,
    executionCtx(),
  );
}

async function errorCodeOf(response: Response): Promise<string> {
  const parsed = (await response.json()) as { error?: { code?: string } };
  return parsed.error?.code ?? '';
}

describe('POST /webhooks/stripe -- signature verification', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // The route logs the verification failure before throwing; silence it so
    // a passing run is not full of red herrings.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => consoleError.mockRestore());

  it('rejects a request with no Stripe-Signature header', async () => {
    const response = await post(eventPayload());

    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('MISSING_SIGNATURE');
  });

  it('rejects a malformed signature header', async () => {
    const response = await post(eventPayload(), { 'stripe-signature': 'not-a-signature' });

    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('INVALID_SIGNATURE');
  });

  it('rejects a body that was tampered with after signing', async () => {
    // THE test on this route. A header-presence check alone passes the two
    // cases above; only this one fails if the signature stops covering the
    // payload. Signed as a $0 change, delivered as a $10,000 one.
    const signed = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: { amount_paid: 0 } } });
    const tampered = JSON.stringify({
      id: 'evt_1',
      type: 'invoice.paid',
      data: { object: { amount_paid: 1000000 } },
    });
    const signature = await signPayload(signed, WEBHOOK_SECRET);

    const response = await post(tampered, { 'stripe-signature': signature });

    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('INVALID_SIGNATURE');
  });

  it('rejects a well-formed signature made with the wrong secret', async () => {
    // What a rotated-but-not-redeployed STRIPE_WEBHOOK_SECRET looks like,
    // and what an attacker guessing the scheme but not the key looks like.
    const payload = eventPayload();
    const signature = await signPayload(payload, 'whsec_test_a_different_fake_secret');

    const response = await post(payload, { 'stripe-signature': signature });

    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('INVALID_SIGNATURE');
  });

  it('rejects a correctly-signed but stale payload (replay protection)', async () => {
    // Stripe's default tolerance is 300s. A captured-and-replayed webhook
    // carries a genuine signature forever; the timestamp is what expires it.
    const payload = eventPayload();
    const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
    const signature = await signPayload(payload, WEBHOOK_SECRET, oneHourAgo);

    const response = await post(payload, { 'stripe-signature': signature });

    expect(response.status).toBe(400);
    expect(await errorCodeOf(response)).toBe('INVALID_SIGNATURE');
  });

  it('opens no database connection on any rejected request', async () => {
    // Independent of the status code, and worth its own assertion: this
    // route is unauthenticated and deliberately NOT rate-limited, so if an
    // unsigned request could reach createDb() it would be a free handle on
    // the Hyperdrive connection pool for anyone who found the URL.
    await post(eventPayload());
    await post(eventPayload(), { 'stripe-signature': 'not-a-signature' });
    await post(eventPayload(), { 'stripe-signature': await signPayload(eventPayload(), 'whsec_wrong') });

    expect(mocks.createDb).not.toHaveBeenCalled();
    expect(mocks.processEvent).not.toHaveBeenCalled();
  });
});

describe('POST /webhooks/stripe -- accepted requests', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a correctly-signed payload and hands the parsed event to the service', async () => {
    const payload = eventPayload('evt_accepted_1');
    const signature = await signPayload(payload, WEBHOOK_SECRET);

    const response = await post(payload, { 'stripe-signature': signature });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });

    // Not just "it was called" -- that the SERVICE received the event Stripe
    // sent, parsed, rather than a re-parse of the raw body somewhere along
    // the way.
    expect(mocks.processEvent).toHaveBeenCalledOnce();
    expect(mocks.processEvent.mock.calls[0]?.[0]).toMatchObject({
      id: 'evt_accepted_1',
      type: 'customer.subscription.updated',
    });
  });

  it('closes the database connection via waitUntil rather than blocking the response', async () => {
    // Stripe treats a slow response as a failure and retries. The close()
    // is deferred for that reason, so assert it is actually deferred.
    const payload = eventPayload('evt_accepted_2');
    const signature = await signPayload(payload, WEBHOOK_SECRET);
    const ctx = executionCtx();

    const response = await app.request(
      '/webhooks/stripe',
      {
        method: 'POST',
        body: payload,
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      },
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
  });
});
