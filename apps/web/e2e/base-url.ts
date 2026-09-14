/**
 * Decides which deployment the e2e specs are allowed to write to.
 *
 * WHY THIS EXISTS (audit P3-5)
 * playwright.staging.config.ts defaulted `baseURL` to
 * `https://echo-grid.uk` -- production. Its own header admitted there is no
 * separate staging environment: "staging" was the same Worker and the same
 * Neon database production uses. So the single command
 *
 *     npx playwright test --config playwright.staging.config.ts
 *
 * ran three specs that each perform a real signup, create a real business
 * with a real public slug, a real branch, a real QR code, and submit real
 * feedback -- against live production. Nothing prompted, nothing warned.
 *
 * WHAT THAT ACTUALLY COSTS, beyond junk rows
 *  - The businesses are PUBLIC. Their slugs are live URLs and they appear
 *    in the platform business directory.
 *  - Nothing is cleaned up. Every table here is soft-delete-only, so the
 *    rows are permanent.
 *  - Submitted feedback enqueues real sentiment classification and summary
 *    generation, which bills Anthropic. The spend limits those charges
 *    count against (ANTHROPIC_DAILY_SPEND_LIMIT_USD, see
 *    AiUsageLogRepository.totalCostSince) are PLATFORM-WIDE, not
 *    per-business -- so a test run can consume budget that real customers'
 *    summaries then get refused for. That is the part that reaches
 *    somebody else's data, and it is why this is a guard and not a comment.
 *
 * The audit's own note was that this was safe only because no script or
 * workflow invoked it -- "one convenience commit deep". Relying on a file
 * staying un-invoked is not a control.
 *
 * THE REAL FIX IS A STAGING ENVIRONMENT: a second Neon branch plus an
 * [env.staging] block in both wrangler.toml files. This function is the
 * guard that belongs there anyway, and the thing that makes the gap
 * impossible to trip over in the meantime.
 */

/**
 * Hosts that reach the production deployment and its database. Sourced from
 * apps/api/wrangler.toml's ALLOWED_ORIGINS and WEB_BASE_URL -- keep in sync
 * when a Custom Domain is added there.
 */
export const PRODUCTION_HOSTNAMES: readonly string[] = [
  'echo-grid.uk',
  'www.echo-grid.uk',
  'echo-grid-feedback-web.katohuzairu122.workers.dev',
];

/**
 * Matched on HOSTNAME, deliberately not on origin.
 *
 * This is the opposite call from lib/allowed-origins.ts in apps/api, which
 * compares full origins -- and the difference is intentional, so please do
 * not "fix" one to match the other. There, the question is "is this a URL
 * our app serves", and scheme is part of the security answer. Here, the
 * question is "does this host reach the production database", for which
 * scheme is irrelevant: http://echo-grid.uk and https://echo-grid.uk are
 * different origins and the same database.
 */
export const PRODUCTION_ACK = 'yes-write-test-data-to-production';

const ENV_BASE_URL = 'E2E_BASE_URL';
const ENV_ACK = 'E2E_ALLOW_PRODUCTION';

export interface ResolveRemoteBaseUrlInput {
  /** process.env.E2E_BASE_URL */
  baseUrl: string | undefined;
  /** process.env.E2E_ALLOW_PRODUCTION */
  ack: string | undefined;
}

/**
 * Returns the origin the specs may run against, or throws with an
 * actionable message. No default: there is no URL that is safe enough to
 * assume, which was the whole defect.
 */
export function resolveRemoteBaseUrl({ baseUrl, ack }: ResolveRemoteBaseUrlInput): string {
  const trimmed = baseUrl?.trim();

  if (!trimmed) {
    throw new Error(
      `${ENV_BASE_URL} is not set.\n\n` +
        'These specs write real data -- signups, businesses with public slugs, ' +
        'feedback that bills Anthropic -- and clean nothing up. There is no ' +
        'default, on purpose: this project has no staging environment, so ' +
        'there is no URL that is safe to assume.\n\n' +
        `Set ${ENV_BASE_URL} to the deployment you intend to write to.`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${ENV_BASE_URL} is not a valid absolute URL: ${trimmed}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${ENV_BASE_URL} must be http or https, got ${parsed.protocol}`);
  }

  // URL lowercases the hostname for us, so a mixed-case env var cannot slip
  // past this list.
  if (PRODUCTION_HOSTNAMES.includes(parsed.hostname) && ack !== PRODUCTION_ACK) {
    throw new Error(
      `Refusing to run the e2e specs against ${parsed.hostname} -- that is production.\n\n` +
        'They would create a real account, a real business on a real public ' +
        'slug, and real feedback, none of which is ever cleaned up (every ' +
        'table here is soft-delete-only). The feedback also bills Anthropic ' +
        'against a PLATFORM-WIDE daily spend limit, so a test run can use up ' +
        "budget that real businesses' summaries are then refused for.\n\n" +
        `If you have decided to accept all of that, set ${ENV_ACK}=${PRODUCTION_ACK}`,
    );
  }

  return parsed.origin;
}
