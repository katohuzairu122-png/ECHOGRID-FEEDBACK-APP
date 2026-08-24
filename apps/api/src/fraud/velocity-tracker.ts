/**
 * Continuing Development Block 4.1 (S5.4 device/IP velocity, S5.5 customer
 * cooldown). KV-backed, not Postgres -- S5.4 asks for this explicitly ("Use
 * KV for fast counters and PostgreSQL as the authoritative reward record"),
 * and it runs on the `CACHE` namespace (wrangler.toml), which had zero call
 * sites anywhere in this codebase before this block -- reused, not a new
 * resource to provision.
 *
 * Deliberately NOT built on the existing `rateLimit()` middleware
 * (middleware/rate-limit.ts). That wraps Cloudflare's native Rate Limiting
 * binding: IP-only, boolean pass/fail, no persisted count, no reason code --
 * a coarse edge gate, working exactly as designed for what it guards. This
 * module is a different, complementary concern: per-device AND per-IP,
 * multi-window, and every check either blocks with a structured reason code
 * or feeds a `fraud_signals` row (Block 3.1) -- neither of which the native
 * binding can do. A request that passes PUBLIC_RATE_LIMITER still has to
 * pass this.
 *
 * Every subject value (a raw device signal, a raw IP, a customerId) is
 * salted and SHA-256 hashed before it ever becomes a KV key or lands in
 * fraud_signals.metadata -- uniformly, even for values (like a customerId)
 * that are already high-entropy and wouldn't strictly need it. One code
 * path with no caller judgment call beats a "hash this one, not that one"
 * split that's one forgotten case away from a raw IP sitting in a fraud
 * signal's metadata. FRAUD_DETECTION_SALT (config/env.ts, wrangler.toml
 * secret) is what makes the hash non-precomputable -- an IP address alone
 * has nowhere near enough entropy to resist a rainbow table otherwise.
 *
 * KV, not a Durable Object or Postgres row, means these counters are only
 * EVENTUALLY consistent -- a get-then-put has a real (if narrow) race
 * window under concurrent requests from the same subject, so a burst can
 * occasionally undercount by one or two. Accepted deliberately: this layer
 * produces a fraud SIGNAL and a soft velocity gate, not the request's only
 * defense (PUBLIC_RATE_LIMITER's atomic native binding is still the hard
 * ceiling in front of it) -- and a fixed window, not a sliding log, is
 * enough accuracy for that job without storing a timestamp per event.
 */

/** The narrow slice of Cloudflare's real KVNamespace this module actually
 * calls -- not the full interface (list, getWithMetadata, bulk ops, ...).
 * Lets a plain in-memory Map satisfy this in tests (unit AND the Postgres
 * integration suite, which has no Workers runtime at all) while the real
 * `c.env.CACHE` binding satisfies it too, structurally, with no adapter. */
export interface VelocityKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
}

export interface VelocityLimits {
  windowSeconds: number;
  threshold: number;
}

export interface VelocityBreach {
  subjectType: 'device' | 'ip';
  subjectHash: string;
  count: number;
  windowSeconds: number;
  threshold: number;
}

interface CounterState {
  count: number;
  windowStart: number;
}

/**
 * Tuning constants. All starting estimates, same status as
 * PUBLIC_RATE_LIMITER's 20/min in wrangler.toml ("a reasonable starting
 * estimate, not derived from real traffic data -- revisit once production
 * usage patterns are known") -- there is no per-business config system for
 * any of this yet (that's a natural Reward Panel / Block 6+ extension, not
 * guessed at here).
 *
 * Device and IP are deliberately asymmetric, not the same threshold twice.
 * Device velocity targets ONE ACTOR repeating an action -- a real customer
 * essentially never submits feedback or checks in 5+ times in 10 minutes,
 * so this can stay tight. IP velocity has to tolerate a single busy branch
 * on shared/guest WiFi legitimately producing many DIFFERENT customers'
 * submissions from one address in a short window (a lunch-rush QR table
 * flow is exactly this) -- set too tight, it would false-positive on the
 * exact high-traffic scenario the product most needs feedback from. IP
 * velocity is a backstop against a clearly automated flood, not a proxy
 * for "one person."
 */
export const FEEDBACK_DEVICE_VELOCITY: VelocityLimits = { windowSeconds: 600, threshold: 5 };
export const FEEDBACK_IP_VELOCITY: VelocityLimits = { windowSeconds: 600, threshold: 40 };
export const CHECKIN_DEVICE_VELOCITY: VelocityLimits = { windowSeconds: 600, threshold: 5 };
export const CHECKIN_IP_VELOCITY: VelocityLimits = { windowSeconds: 600, threshold: 40 };

/** Feedback cooldown is signal-only (see qr.routes.ts) -- there is no
 * reward yet to withhold, so 30 minutes just needs to be short enough to
 * catch "same device, same branch, tight loop" without being long enough
 * to suppress a customer's second, genuinely separate visit later the same
 * day. */
export const FEEDBACK_COOLDOWN_SECONDS = 30 * 60;

/** Check-in cooldown IS enforced (see loyalty-customer.routes.ts) -- unlike
 * feedback, a check-in's points are real, already-live value today, not a
 * future reward. 4 hours allows multiple genuine visits in one day (a
 * regular's morning-and-evening coffee run) while blocking a rapid
 * repeat-scan of the same visit. */
export const CHECKIN_COOLDOWN_SECONDS = 4 * 60 * 60;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export class VelocityTracker {
  constructor(
    private readonly kv: VelocityKv,
    private readonly salt: string,
  ) {}

  /** Salted SHA-256, hex-encoded -- same Web-Crypto primitive as
   * feedback/text-normalizer.ts's hashNormalizedText and qr/qr-token.ts's
   * signing, salted (unlike that one) because the input here is often
   * low-entropy and guessable (an IP, a device signal), not already-random. */
  async hashSubject(value: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${this.salt}:${value}`));
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** Fixed-window counter: increments (eventType, subjectType, subject)'s
   * current window and returns the post-increment count. A fixed window
   * (not a sliding log of individual event timestamps) trades a small,
   * accepted amount of boundary imprecision -- a burst spanning a window
   * rollover can undercount slightly -- for storing one counter instead of
   * one entry per event, consistent with this module's "signal, not a hard
   * security boundary" framing above. */
  private async increment(
    eventType: string,
    subjectType: 'device' | 'ip',
    subjectHash: string,
    windowSeconds: number,
  ): Promise<number> {
    const key = `velocity:${eventType}:${subjectType}:${subjectHash}`;
    const raw = await this.kv.get(key);
    const existing = raw ? (JSON.parse(raw) as CounterState) : null;
    const t = now();

    const state: CounterState =
      existing && t - existing.windowStart < windowSeconds
        ? { count: existing.count + 1, windowStart: existing.windowStart }
        : { count: 1, windowStart: t };

    await this.kv.put(key, JSON.stringify(state), { expirationTtl: windowSeconds });
    return state.count;
  }

  /**
   * Checks and increments BOTH device (if a signal was supplied) and IP
   * velocity for one event, unconditionally -- a breach on one must not
   * leave the other's counter stale for next time. Returns the first
   * breach found, device checked first since it's the more specific,
   * higher-confidence signal when both fire at once; null if neither
   * breached. Callers decide what a breach means (qr.routes.ts and
   * loyalty-customer.routes.ts both currently choose to block).
   */
  async checkVelocity(params: {
    eventType: string;
    ip: string;
    deviceSignal?: string | undefined;
    deviceLimits: VelocityLimits;
    ipLimits: VelocityLimits;
  }): Promise<VelocityBreach | null> {
    let deviceBreach: VelocityBreach | null = null;
    if (params.deviceSignal) {
      const hash = await this.hashSubject(params.deviceSignal);
      const count = await this.increment(params.eventType, 'device', hash, params.deviceLimits.windowSeconds);
      if (count > params.deviceLimits.threshold) {
        deviceBreach = {
          subjectType: 'device',
          subjectHash: hash,
          count,
          windowSeconds: params.deviceLimits.windowSeconds,
          threshold: params.deviceLimits.threshold,
        };
      }
    }

    const ipHash = await this.hashSubject(params.ip);
    const ipCount = await this.increment(params.eventType, 'ip', ipHash, params.ipLimits.windowSeconds);
    const ipBreach: VelocityBreach | null =
      ipCount > params.ipLimits.threshold
        ? {
            subjectType: 'ip',
            subjectHash: ipHash,
            count: ipCount,
            windowSeconds: params.ipLimits.windowSeconds,
            threshold: params.ipLimits.threshold,
          }
        : null;

    return deviceBreach ?? ipBreach;
  }

  /**
   * Has (eventType, subjectValue) already happened within windowSeconds?
   * Check-and-start in one call, not two, because for cooldown's purpose
   * "checking" and "the qualifying action happening" are the same moment --
   * unlike velocity, which counts every attempt regardless of outcome, a
   * cooldown only ever needs to know "did this already happen recently,"
   * and if not, mark it as having just happened. Leaves an already-active
   * cooldown's expiry untouched (does not extend it) -- a repeat attempt
   * during cooldown shouldn't push the window further out.
   */
  async checkAndStartCooldown(params: {
    eventType: string;
    subjectValue: string;
    windowSeconds: number;
  }): Promise<{ inCooldown: boolean; subjectHash: string }> {
    const hash = await this.hashSubject(params.subjectValue);
    const key = `cooldown:${params.eventType}:${hash}`;
    const existing = await this.kv.get(key);
    if (existing) {
      return { inCooldown: true, subjectHash: hash };
    }
    await this.kv.put(key, '1', { expirationTtl: params.windowSeconds });
    return { inCooldown: false, subjectHash: hash };
  }
}
