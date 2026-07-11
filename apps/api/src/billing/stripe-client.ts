import Stripe from 'stripe';

/**
 * The one deliberate exception to this codebase's established "call the
 * provider's REST API via plain fetch(), skip the Node SDK" pattern
 * (TwilioSmsService, AnthropicSummaryGenerator, ResendEmailService -- see
 * each one's own doc comment). Those three were avoided because their
 * Workers-runtime SDK compatibility was unverified and each only needed a
 * handful of simple, single-purpose POST calls -- a fetch() call was both
 * safer and less code. Stripe is different on both counts:
 *
 *  1. Cloudflare and Stripe jointly announced and documented native Workers
 *     support for the official `stripe` SDK (confirmed via live search,
 *     2026-07-11: https://blog.cloudflare.com/announcing-stripe-support-in-workers/),
 *     configured with a fetch-based HTTP client -- this is a verified,
 *     supported path, not an unverified risk.
 *  2. Stripe's request bodies use a non-trivial nested-bracket
 *     `application/x-www-form-urlencoded` format
 *     (`line_items[0][price_data][unit_amount]=...`) that the SDK serializes
 *     correctly and a hand-rolled fetch() call would be genuinely easy to
 *     get subtly wrong -- unlike Twilio/Resend/Anthropic's flat JSON bodies.
 *
 * Applying this codebase's own decision rule (verified Workers compatibility
 * -> prefer the native path; unverified -> avoid it and use fetch) simply
 * produces a different answer for Stripe specifically -- this is not an
 * arbitrary reversal of the established pattern.
 */

/** Web Crypto-backed signature provider, required for constructEventAsync()
 * below -- Workers has no Node `crypto` module, so the SDK's default
 * (synchronous, Node-crypto-based) webhooks.constructEvent() cannot run
 * here. Stateless and cheap to construct; safe to call once per request
 * rather than caching at module scope. */
export function createWebhookCryptoProvider() {
  return Stripe.createSubtleCryptoProvider();
}

/**
 * Constructs a request-scoped Stripe client. Not cached/reused across
 * requests (same "cheap to open, not free to hold open" reasoning already
 * applied to this codebase's per-request Postgres client, db/client.ts) --
 * the SDK itself holds no persistent connection, so there is no pooling
 * benefit to sharing an instance, and a fresh instance per request avoids
 * any risk of accidentally leaking state across isolates.
 *
 * apiVersion is pinned explicitly rather than left to the account default,
 * so a Stripe-side default-version rollout can never silently change this
 * integration's behavior. '2026-05-27.dahlia' is current as of this block's
 * live search (2026-07-11) -- CONFIRM the current version string against
 * https://docs.stripe.com/api/versioning before deploying to production;
 * not asserted here as a permanently fixed fact, same treatment as this
 * codebase's ANTHROPIC_MODEL env var (config/env.ts).
 */
export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: '2026-05-27.dahlia' as Stripe.LatestApiVersion,
  });
}
