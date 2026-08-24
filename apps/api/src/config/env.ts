import { z } from 'zod';
import type { SentimentJob } from '../sentiment/sentiment-job';
import type { SendNotificationJob } from '../notifications/notification-job';
import type { EscalateCriticalIncidentJob } from '../feedback/critical-alert-job';

/**
 * Every job type that can travel over the shared `JOBS` queue -- grows as
 * each domain (sentiment, notifications, and eventually loyalty
 * recalculation, per wrangler.toml's own binding comment) adds its own job
 * type. Each domain still exports its own narrowly-typed `enqueueX(queue:
 * Queue<ItsOwnJobType>, ...)` helper (sentiment-job.ts, notification-job.ts)
 * -- a `Queue<PlatformJob>` binding is assignable to each of those narrower
 * parameter types via normal contravariant function-parameter typing, so
 * nothing at the call sites needs to change as this union grows.
 */
export type PlatformJob = SentimentJob | SendNotificationJob | EscalateCriticalIncidentJob;

/**
 * Wrangler resource + secret bindings available on `c.env` for every request.
 * Mirrors apps/api/wrangler.toml -- keep both in sync when a binding changes.
 * Regenerate a reference copy anytime with `pnpm --filter @echo-grid-feedback/api types`.
 */
export interface Bindings {
  /** Non-secret config, set via wrangler.toml [vars]. */
  ENVIRONMENT: 'development' | 'staging' | 'production';

  /** Secrets, declared in wrangler.toml [secrets].required, set via `wrangler secret put`. */
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;

  /** Customer identity (Loyalty module) -- deliberately a separate secret
   * from the staff JWT_ACCESS_SECRET, so a leak of one token system never
   * compromises the other (see customer-auth/customer-jwt.ts). */
  CUSTOMER_JWT_SECRET: string;

  /** Signs/verifies QR tokens (Continuing Development Block 3.2, qr/qr-token.ts)
   * -- its own secret, same leak-isolation reasoning as CUSTOMER_JWT_SECRET
   * above. */
  QR_TOKEN_SECRET: string;
  /** Deliberately allowed to be `undefined` -- the first secret in this
   * interface without a guaranteed value, and deliberately so: S5.2 asks
   * for signing-key rotation support, and rotation only means something if
   * the outgoing secret can be ABSENT once the rotation window closes. Set
   * only during an active QR_TOKEN_SECRET rotation (see qr-token.ts's
   * verifyQrToken doc comment); leave unset otherwise. Not listed in
   * [secrets].required below -- wrangler's required-check would then
   * demand it always be set, which defeats the point.
   *
   * Typed as `string | undefined` on a REQUIRED key, not `?: string` --
   * with exactOptionalPropertyTypes on (tsconfig.base.json), an optional
   * (`?`) property can't be assigned a `string | undefined` value
   * explicitly (only omitted entirely), which doesn't fit how this value
   * actually flows: c.env.QR_TOKEN_SECRET_PREVIOUS is read and passed
   * through Pick<Bindings, ...> object literals at every QrCodeService call
   * site, not conditionally omitted. This form matches actual Workers
   * runtime behavior too -- an unset binding reads as `undefined`, not as a
   * genuinely absent key. */
  QR_TOKEN_SECRET_PREVIOUS: string | undefined;

  /** Salts device-signal/IP hashing for velocity + cooldown checks
   * (Continuing Development Block 4.1, S5.4/S5.5 -- fraud/velocity-tracker.ts).
   * Its own secret, same leak-isolation reasoning as QR_TOKEN_SECRET/
   * CUSTOMER_JWT_SECRET above -- and needed at all only because an IP or a
   * client-supplied device signal is low-entropy and guessable on its own;
   * without a secret salt, an attacker could precompute hashes for the
   * entire IPv4 space. No rotation-pair variant (unlike QR_TOKEN_SECRET):
   * every value this salts is scoped to a KV entry with a TTL measured in
   * minutes/hours (fraud/velocity-tracker.ts's *_COOLDOWN_SECONDS /
   * *_VELOCITY windows), not QR_TOKEN_SECRET's 365-day signed tokens, so a
   * rotation just means yesterday's counters age out on their own TTL --
   * there is nothing long-lived that would need a _PREVIOUS fallback to
   * keep verifying. */
  FRAUD_DETECTION_SALT: string;

  /** Twilio REST API credentials (customer-auth/sms.service.ts) -- called
   * via plain fetch(), not the Twilio Node SDK, whose Workers-runtime
   * compatibility is unverified. Unused when ENVIRONMENT !== 'production'
   * (ConsoleSmsService logs instead, see sms.service.ts). */
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_FROM_NUMBER: string;

  /** Anthropic API (Sentiment Analytics Block 3) -- powers the LLM-backed
   * summary/recommendation engine only, called via plain fetch() (see
   * sentiment/summary-generator.ts), same SDK-avoidance reasoning as Twilio.
   * Unused when ENVIRONMENT !== 'production' (ConsoleSummaryGenerator
   * substitutes, same pattern as ConsoleSmsService). */
  ANTHROPIC_API_KEY: string;
  /** Non-secret model identifier, [vars] not [secrets] -- kept swappable
   * without a code deploy. Confirm the current valid model string against
   * Anthropic's docs (docs.claude.com) before setting this in production;
   * not hard-coded here since model identifiers change over time. */
  ANTHROPIC_MODEL: string;

  /** Resend API (Notifications Block 2) -- transactional email delivery,
   * called via plain fetch(), same SDK-avoidance reasoning as Twilio/
   * Anthropic. Unused when ENVIRONMENT !== 'production' (ConsoleEmailService
   * substitutes, see notifications/email.service.ts). */
  RESEND_API_KEY: string;
  /** Non-secret sender identity, [vars] not [secrets] -- one platform-wide
   * "from" address for v1; per-business sender identity is future scope. */
  RESEND_FROM_ADDRESS: string;

  /** Stripe (Billing Block 8) -- the one deliberate exception to this
   * project's usual "plain fetch(), skip the SDK" rule; see billing/
   * stripe-client.ts's doc comment for why. Use a `sk_test_...` key in
   * development/staging (real API calls against Stripe's test mode, fake
   * money) -- there is no ConsoleStripeClient-style fallback the way
   * Twilio/Resend/Anthropic have one, because Checkout/Portal are real
   * hosted-page redirects with no meaningful way to fake a URL to redirect
   * to; Stripe's own test mode is the correct substitute instead. */
  STRIPE_SECRET_KEY: string;
  /** Signing secret for the /webhooks/stripe endpoint (a distinct value per
   * Stripe webhook endpoint you configure -- see the Stripe Dashboard's
   * Webhooks section, not the same value as STRIPE_SECRET_KEY). */
  STRIPE_WEBHOOK_SECRET: string;

  /** Comma-separated list of allowed CORS origins for apps/web's deployed
   * domain(s) (e.g. "https://app.example.com,https://staging.example.com").
   * [vars], not [secrets] -- an allow-list of origins isn't sensitive, same
   * classification as RESEND_FROM_ADDRESS/ANTHROPIC_MODEL below. Moved out
   * of a hardcoded array in index.ts (was a standing TODO/known gap, see
   * docs/ARCHITECTURE.md's Risks) specifically so a new environment's origin
   * is a wrangler.toml [vars] edit, not an application-code change -- see
   * index.ts's cors() config for where this is read. Defaults to
   * "http://localhost:3000" in wrangler.toml's [vars] for local dev; this
   * type has no default because a genuinely missing value should fail
   * closed (no origins allowed) rather than silently allow everything. */
  ALLOWED_ORIGINS: string;

  /** Public origin of the deployed apps/web Worker, e.g.
   * "https://echo-grid.uk" -- used to build the link inside password-reset
   * emails (auth/password-reset.ts's buildResetLink). [vars], not [secrets]:
   * a public URL is not sensitive, same classification as ALLOWED_ORIGINS
   * above. Kept as its own value rather than parsed out of ALLOWED_ORIGINS,
   * which is a *list* of origins permitted to call the API and has no
   * defined "primary" entry -- picking one would be guesswork that silently
   * mails staging users a localhost link. */
  WEB_BASE_URL: string;

  /** Resource bindings, provisioned with the Cloudflare CLI (see README). */
  HYPERDRIVE: Hyperdrive;
  UPLOADS: R2Bucket;
  CACHE: KVNamespace;
  JOBS: Queue<PlatformJob>;

  /** Durable Object namespace for PasswordHasherDurableObject (auth/
   * password-hasher.do.ts) -- routes PBKDF2 hashing/verification here so
   * the compute runs on the DO's own CPU budget instead of the HTTP-
   * handling Worker's 10ms-on-Free-plan limit. See auth/pbkdf2-worker.ts
   * for the client side; never call the DO directly from a route. */
  PASSWORD_HASHER: DurableObjectNamespace;

  /** Workers AI (Sentiment Analytics Block 2) -- a native binding, not a
   * secret; no API key to provision. Used only for per-item sentiment
   * classification (sentiment/sentiment-classifier.ts). The LLM-backed
   * summary/recommendation engine (Block 3) is a separate external call,
   * not this binding -- Workers AI's catalog has no strong general-purpose
   * text-generation model suited to that job as of this writing. */
  AI: Ai;

  /** Rate limiting bindings (Block 7, extended in QR Engagement Block 2) --
   * namespace_id values are defined directly in wrangler.toml, not
   * provisioned via CLI. */
  AUTH_RATE_LIMITER: RateLimit;
  API_RATE_LIMITER: RateLimit;
  PUBLIC_RATE_LIMITER: RateLimit;
  /** Loyalty Block 2 -- deliberately stricter than PUBLIC_RATE_LIMITER: each
   * request costs real money (one SMS via Twilio), unlike a free feedback
   * submission, so the abuse budget is much smaller. */
  OTP_RATE_LIMITER: RateLimit;
  /** Guards POST /qr/:token/follow-up-question (qr.routes.ts) -- same
   * "this specific request costs real money" reasoning as OTP_RATE_LIMITER:
   * every successful call is a real Anthropic API charge, unlike a free
   * feedback submission or a rate-limited retry against it. */
  FOLLOWUP_QUESTION_RATE_LIMITER: RateLimit;
}

const environmentSchema = z.enum(['development', 'staging', 'production']);

/**
 * Wrangler's `[secrets].required` already guarantees the JWT secrets exist by the
 * time a request reaches the Worker -- this only validates the one free-text value
 * ([vars] ENVIRONMENT) that Wrangler can't type-check on its own.
 */
export function parseEnvironment(value: string): Bindings['ENVIRONMENT'] {
  return environmentSchema.parse(value);
}
