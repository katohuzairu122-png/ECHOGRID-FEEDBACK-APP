import type { Bindings } from '../config/env';

/**
 * Tells a human when background work fails.
 *
 * WHAT THIS FIXES (audit P3-2, P3-3, P3-4)
 * The platform had no error reporting of any kind -- a repo-wide search for
 * Sentry, OpenTelemetry, Datadog, Axiom or any logger returned nothing, and
 * all 33 logging call sites were `console.*`. Observability was Cloudflare
 * Workers Logs: a dashboard tail with no grouping, no trend and NO
 * ALERTING. So the declared dead-letter queue had no consumer and nothing
 * watching it, a rejected cron sweep was one log line nobody would read,
 * and a Workers AI outage was discovered when a business owner noticed
 * their feedback had stopped being classified.
 *
 * All three findings are the same defect -- "nobody is told" -- not "error
 * grouping is poor". That is why this is a webhook and not an SDK.
 *
 * WHY VENDOR-NEUTRAL
 * A Worker on the free plan has a 10ms CPU budget per invocation; this
 * project already had to move PBKDF2 into a Durable Object to live within
 * it (see auth/password-hasher.do.ts). Adding an instrumentation SDK to
 * that budget to solve a notification problem is the wrong trade. One
 * fetch() to a URL costs nothing measurable and works with every
 * destination: a Slack or Discord incoming webhook, a vendor ingest
 * endpoint, or a Worker of your own. Choosing Sentry or Baselime later
 * means setting a different secret, not rewriting call sites.
 *
 * NEVER THROWS, AND ALWAYS LOGS
 * An alerting path that can fail the thing it reports on is worse than no
 * alerting. Every call logs to console.error first and unconditionally, so
 * the Workers Logs trail exists whether or not a webhook is configured and
 * whether or not delivery succeeds -- then attempts delivery, swallowing
 * anything that goes wrong with it.
 */

export type OpsAlertSeverity = 'warning' | 'critical';

export interface OpsAlert {
  /** Stable machine-readable key, dot-namespaced: 'queue.dead_letter',
   * 'cron.sweep_failed'. Meant to be groupable and greppable, so it must
   * not embed ids or counts -- those go in `detail`. */
  event: string;
  severity: OpsAlertSeverity;
  /** One sentence a human reads first, in a notification with no context
   * around it. */
  message: string;
  /**
   * Ids, counts, job types, error messages. NEVER customer prose, phone
   * numbers or email addresses: this leaves the platform for a third-party
   * destination, which is a lower bar than the database it came from. The
   * callers in index.ts pass message ids, job type discriminants and
   * attempt counts, all of which are already safe to log.
   */
  detail?: Record<string, unknown>;
}

/** Bounded so a hanging webhook endpoint cannot hold the invocation open.
 * Short on purpose -- this is best-effort notification, and the console
 * line above it is the durable record. */
const DELIVERY_TIMEOUT_MS = 3000;

export const OPS_ALERT_SERVICE = 'echo-grid-feedback-api';

export async function notifyOps(
  env: Pick<Bindings, 'ENVIRONMENT' | 'OPS_ALERT_WEBHOOK_URL'>,
  alert: OpsAlert,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const text = `[${alert.severity}] ${OPS_ALERT_SERVICE} (${env.ENVIRONMENT}): ${alert.message}`;

  // First and unconditionally. If the webhook is unset, misconfigured, or
  // the destination is down, this line is still in Workers Logs.
  console.error(text, alert.detail ?? {});

  if (!env.OPS_ALERT_WEBHOOK_URL) return;

  try {
    await fetch(env.OPS_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `text` AND `content` alongside the structured fields, deliberately:
      // a Slack incoming webhook renders `text`, a Discord one renders
      // `content`, and a vendor or custom endpoint reads the structured
      // fields and ignores both. One payload that works with all three
      // beats a config switch nobody will remember exists.
      body: JSON.stringify({
        text,
        content: text,
        service: OPS_ALERT_SERVICE,
        environment: env.ENVIRONMENT,
        event: alert.event,
        severity: alert.severity,
        message: alert.message,
        detail: alert.detail ?? {},
        timestamp,
      }),
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    // Response status deliberately unchecked. A 4xx from the destination is
    // a configuration problem for a human to notice in its own dashboard,
    // and retrying or escalating from inside an alerting path is how you
    // turn one incident into two.
  } catch (err) {
    // Includes an unsupported AbortSignal.timeout, a DNS failure, a
    // timeout, or the destination being down. The console line above
    // already carries the alert; this only records that delivery failed.
    console.error('Ops alert delivery failed.', {
      event: alert.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Runs `work` and alerts if it rejects, resolving either way.
 *
 * For `ctx.waitUntil(...)` callers. A rejected promise handed to waitUntil
 * is an unhandled rejection: the Worker logs something unattributed and
 * nothing is notified, which is precisely how the cron sweeps in index.ts
 * could fail silently. Wrapping them means a failure becomes an alert with
 * a name attached.
 *
 * Resolves to `undefined` on failure rather than rethrowing, so a caller
 * can await it without inheriting the rejection -- the point is that the
 * failure has been REPORTED, not that it should propagate.
 */
export async function alertOnFailure<T>(
  env: Pick<Bindings, 'ENVIRONMENT' | 'OPS_ALERT_WEBHOOK_URL'>,
  alert: Omit<OpsAlert, 'detail'> & { detail?: Record<string, unknown> },
  work: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (err) {
    await notifyOps(env, {
      ...alert,
      detail: {
        ...(alert.detail ?? {}),
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return undefined;
  }
}
