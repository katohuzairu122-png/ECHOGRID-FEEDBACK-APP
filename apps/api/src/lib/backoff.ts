// Continuing Development S4 Block 6 (S4.3 "retry with bounded exponential
// backoff"). Every queue message this platform retries -- feedback
// classification, summary generation, notification delivery, critical-
// incident escalation, see index.ts's `queue` consumer's single shared
// catch block -- follows this same delay schedule. There's no case in this
// codebase today where one job type's transient-infra failures (Workers AI
// hiccup, DB connection drop, email/SMS provider outage -- queue's own doc
// comment) need a different retry cadence than another's, so one shared
// schedule is used rather than a per-job-type table that has no real
// caller asking for different behavior yet.
const BASE_RETRY_DELAY_SECONDS = 30;
// Bounded: growth stops here even if wrangler.toml's max_retries (currently
// 3, so `attempts` this function actually sees in production tops out at 3)
// is ever raised later without this function being revisited.
const MAX_RETRY_DELAY_SECONDS = 300;

/**
 * Computes the delay before a queue message's next redelivery, doubling
 * with each failed attempt and capped at MAX_RETRY_DELAY_SECONDS. Pure and
 * side-effect free so it's directly unit-tested without a simulated
 * Cloudflare Queues runtime (see backoff.test.ts) -- index.ts's queue
 * consumer is the one real caller, passing `message.attempts` (the
 * delivery attempt that just failed) and using the result as
 * `message.retry({ delaySeconds: computeRetryDelaySeconds(message.attempts) })`.
 *
 * `attempts` is Cloudflare Queues' own Message.attempts value: 1 on a
 * message's first delivery, 2 on its first redelivery, and so on -- so
 * attempts=1 having just failed returns BASE_RETRY_DELAY_SECONDS (the delay
 * before the 2nd delivery), not 0.
 *
 * Not verified against a real Cloudflare Queues runtime in this sandbox (no
 * installed toolchain here at all -- see this block's own completion
 * notes); `Message.attempts`/`retry({ delaySeconds })` are long-standing,
 * documented Cloudflare Queues Consumer API, not new surface, but real
 * `pnpm typecheck` against the installed `@cloudflare/workers-types`
 * package is the actual confirmation this sandbox cannot provide.
 */
export function computeRetryDelaySeconds(attempts: number): number {
  if (attempts < 1) {
    // Loud failure instead of a silently negative/NaN delay from
    // 2 ** (attempts - 1) going the wrong direction -- same "throw for an
    // impossible input rather than guess" convention as
    // summary-generator.ts's calculateCostUsd throwing on an unpriced
    // model, not defaulting to $0.
    throw new RangeError(
      `attempts must be >= 1 (Cloudflare Queues' Message.attempts is 1-indexed, starting at 1 on first delivery), got ${attempts}`,
    );
  }
  const exponential = BASE_RETRY_DELAY_SECONDS * 2 ** (attempts - 1);
  return Math.min(exponential, MAX_RETRY_DELAY_SECONDS);
}

// Exported so tests assert against the real constants rather than a
// hardcoded duplicate that could silently drift from them -- same
// convention as summary-generator.ts exporting PROMPT_VERSION for its own
// tests to import.
export { BASE_RETRY_DELAY_SECONDS, MAX_RETRY_DELAY_SECONDS };
