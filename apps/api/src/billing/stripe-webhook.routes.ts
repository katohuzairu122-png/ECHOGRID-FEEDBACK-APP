import { Hono } from 'hono';
import type Stripe from 'stripe';
import type { Bindings } from '../config/env';
import { createDb } from '../db/client';
import { createRepositories } from '../repositories';
import { AppError } from '../lib/errors';
import { createStripeClient, createWebhookCryptoProvider } from './stripe-client';
import { StripeWebhookService } from './stripe-webhook.service';
import { recordVerifiedStripeSubscriptionObservation } from './stripe-subscription-history.recorder';
import { handleEnforcedCapture, isCaptureOff, maxBodyBytes } from './stripe-evidence';

/**
 * Mounted at the root app level in index.ts (app.route(...), NOT inside the
 * /api/v1 sub-app) -- same reasoning /health already established for
 * skipping that middleware stack: Stripe is a server calling this
 * unauthenticated (no JWT to check, no CORS-relevant browser origin) and
 * deliberately NOT rate-limited (a legitimate post-outage retry burst from
 * Stripe must never be throttled -- the webhook signature below IS this
 * route's real security boundary, not a rate limiter).
 *
 * Reads the raw body as text FIRST, before anything else touches the
 * request -- a known Workers/Hono gotcha (confirmed via live search,
 * 2026-07-11) is "Body has already been used" if any body-parsing
 * middleware reads the stream ahead of a handler that needs the raw bytes
 * for signature verification. Mounting this route entirely outside the
 * globally-applied `api` middleware stack sidesteps the issue by
 * construction, not just by ordering.
 */
export const stripeWebhookRoutes = new Hono<{ Bindings: Bindings }>();

stripeWebhookRoutes.post('/', async (c) => {
  // HETA-01-F1: with STRIPE_EVIDENCE_CAPTURE unset or `off` (the default) this branch is skipped and the
  // code below runs exactly as before. Any other value takes the evidence pipeline (capture before legacy).
  if (!isCaptureOff(c.env)) {
    const declared = Number(c.req.header('content-length'));
    const tooLarge = Number.isFinite(declared) && declared > maxBodyBytes(c.env);
    const result = await handleEnforcedCapture({
      rawBody: tooLarge ? '' : await c.req.text(),
      signatureHeader: c.req.header('stripe-signature'),
      contentLength: Number.isFinite(declared) ? declared : null,
      env: c.env,
      openDb: () => createDb(c.env.HYPERDRIVE),
      runLegacy: async (event, db) => {
        await new StripeWebhookService(createRepositories(db)).processEvent(event);
        await recordVerifiedStripeSubscriptionObservation(db, event);
      },
      log: (msg, data) => console.error(msg, data ?? {}),
    });
    switch (result.status) {
      case 200:
        return c.json({ received: true });
      case 400:
        throw new AppError(result.body.error === 'MISSING_SIGNATURE' ? 'Missing Stripe-Signature header.' : 'Invalid webhook signature.', 400, result.body.error);
      case 409:
        throw new AppError('Event is being processed; retry later.', 409, result.body.error);
      case 413:
        return c.json({ success: false, error: { code: result.body.error, message: 'Payload too large.' } }, 413);
      case 503:
        return c.json({ success: false, error: { code: result.body.error, message: 'Event capture is unavailable; retry later.' } }, 503);
    }
  }

  const signature = c.req.header('stripe-signature');
  if (!signature) {
    throw new AppError('Missing Stripe-Signature header.', 400, 'MISSING_SIGNATURE');
  }

  const body = await c.req.text();
  const stripe = createStripeClient(c.env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      createWebhookCryptoProvider(),
    );
  } catch (err) {
    // Never retried by Stripe for a 400, correctly -- an invalid signature
    // will never become valid on redelivery. Message is deliberately
    // generic; the real reason (bad secret, tampered body, ...) is server
    // log detail only, not something to hand back over HTTP.
    console.error('Stripe webhook signature verification failed:', err);
    throw new AppError('Invalid webhook signature.', 400, 'INVALID_SIGNATURE');
  }

  // Uncaught errors below intentionally propagate to the global error
  // handler (index.ts's app.onError) as a 500 rather than being swallowed
  // here -- Stripe retries non-2xx responses with backoff for up to 3 days,
  // which is the correct behavior for a transient failure (a DB hiccup, an
  // Hyperdrive connection blip), the same "let genuine infra failures retry"
  // reasoning already applied to the JOBS queue consumer in index.ts.
  const { db, close } = await createDb(c.env.HYPERDRIVE);
  try {
    const service = new StripeWebhookService(createRepositories(db));
    await service.processEvent(event);
    // Signature-verified provider observation only; never credit issuance authority.
    await recordVerifiedStripeSubscriptionObservation(db, event);
  } finally {
    c.executionCtx.waitUntil(close());
  }

  return c.json({ received: true });
});
