import { Hono } from 'hono';
import type { Bindings } from '../config/env';
import { authenticate, type AuthVariables } from '../middleware/authenticate';
import { requirePlatformRole, type PlatformVariables } from '../middleware/require-platform-role';
import { notifyOps } from '../lib/ops-alert';
import { ok } from '../lib/response';

type Env = {
  Bindings: Bindings;
  Variables: AuthVariables & PlatformVariables;
};

export const platformOpsRoutes = new Hono<Env>();

/**
 * Admin only, unlike audit-log.routes.ts which admits all three platform
 * roles. Reading cross-tenant data is support's job; making the on-call
 * channel light up is not. An explicit allow-list, so 'support' and
 * 'billing' are refused by requirePlatformRole rather than by anything here.
 */
platformOpsRoutes.use('*', authenticate, requirePlatformRole(['admin']));

/**
 * The FIXED payload. Declared at module scope, frozen, and referenced —
 * never spread over, never merged with anything from the request.
 *
 * This is the security property of the whole endpoint, so it is worth being
 * blunt about: this route takes NO input. It does not read the body, the
 * query string, or any header beyond the ones `authenticate` needs. A
 * request carrying `{"webhookUrl": "https://attacker.example", "severity":
 * "critical", "message": "..."}` produces exactly the alert below, to
 * exactly the configured destination. There is no code path from request
 * data into notifyOps, which is stronger than validating input would be:
 * nothing to validate, nothing to get wrong later.
 */
const DELIVERY_TEST_ALERT = Object.freeze({
  event: 'ops.delivery_test',
  severity: 'warning',
  message: 'Echo Grid operations alert delivery test.',
  detail: Object.freeze({ source: 'platform_admin' }),
} as const);

/**
 * POST /api/v1/platform/ops/test-alert
 *
 * Proves the deployed alert pipeline end to end:
 *
 *   request -> Worker -> notifyOps() -> OPS_ALERT_WEBHOOK_URL -> ops channel
 *
 * WHY THIS EXISTS
 * `wrangler secret put OPS_ALERT_WEBHOOK_URL` confirms a secret is stored;
 * it does not confirm a human receives anything. The previous way to check
 * was to curl the webhook by hand, which tests the destination but not the
 * Worker's binding, the code path, or the payload — and requires pasting a
 * live credential into a shell. This exercises the real pipeline and needs
 * no access to the secret at all.
 *
 * `severity: 'warning'`, not 'critical' (audit P3-2/P3-3/P3-4 reserve
 * 'critical' for dead-lettered jobs and failed cron sweeps). A diagnostic
 * someone fired on purpose must never look like an incident in the channel,
 * and the message says so in plain words for the same reason.
 *
 * ALWAYS 200, EVEN IF DELIVERY FAILS — deliberately. `notifyOps` never
 * throws and never reports its own outcome: it logs to console.error first
 * and unconditionally, then attempts delivery, swallowing a bad URL, a DNS
 * failure or a 404 (see lib/ops-alert.ts on why escalating from inside an
 * alerting path turns one incident into two). Reflecting a delivery result
 * here would mean changing that, which requirement 9 rules out, and would
 * also leak whether the configured URL is valid to the caller.
 *
 * So the response confirms the alert was DISPATCHED, not that it arrived,
 * and `checkChannel` says as much. The read is: alert in the channel =>
 * whole pipeline works. Nothing in the channel but a line in `wrangler tail`
 * => code is fine, the webhook URL is wrong. That split is exactly what
 * "always log first" was built to make visible.
 */
platformOpsRoutes.post('/test-alert', async (c) => {
  await notifyOps(c.env, DELIVERY_TEST_ALERT);

  // No echo of the alert payload and certainly not of the destination:
  // OPS_ALERT_WEBHOOK_URL is a credential (anyone holding it can post into
  // the channel), and a diagnostic endpoint is a poor place to start
  // reflecting env values. `event` is a fixed literal from this file, safe
  // to return, and useful for grepping the channel for the right message.
  return ok(c, {
    dispatched: true,
    event: DELIVERY_TEST_ALERT.event,
    checkChannel: 'Delivery is best-effort and not reported here. Confirm the alert arrived in the operations channel.',
  });
});
