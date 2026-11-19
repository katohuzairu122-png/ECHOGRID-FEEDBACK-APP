import { HarnessRefusal, assertAllowedUrl, guardTargets, isProductionHost, verifyStagingIdentity, type FetchFn, type TargetsConfig } from './guard';
import type { MessageSourceFactory } from './verification-mailbox';

/**
 * CASHIER-AUTH-02E E2: the live-acceptance readiness preflight.
 *
 * It answers one question, item by item and without side effects: "may a live staging acceptance run start, and if not, exactly why not?"
 * Each item is PASS, BLOCKED (a prerequisite is known to be missing) or NOT VERIFIED (it cannot be checked, or was deliberately not checked).
 * It makes NO network request unless the owner's host approval AND live-execution authorization are both recorded and `--online` is given; with
 * the shipped configuration it is entirely offline. It never prints a value: only names, statuses and short reasons.
 */
export type PreflightStatus = 'PASS' | 'BLOCKED' | 'NOT VERIFIED';

export interface PreflightItem {
  id: string;
  title: string;
  status: PreflightStatus;
  detail: string;
  /** A required item must PASS for the verdict to be READY. */
  required: boolean;
}

export interface PreflightDeps {
  env: Readonly<Record<string, string | undefined>>;
  fetch: FetchFn;
  /** Reads a repository file by name ('api-wrangler' | 'web-wrangler'); null when unavailable. */
  readRepoFile: (name: 'api-wrangler' | 'web-wrangler') => string | null;
  adapters: Readonly<Record<string, MessageSourceFactory>>;
  /** Is the browser automation usable here? */
  browser: () => Promise<{ ok: boolean; detail: string }>;
  /** Is the real sign-up driver present in this build? */
  driverPresent: () => boolean;
}

export interface PreflightResult {
  items: PreflightItem[];
  verdict: 'READY' | 'NOT READY';
  /** 0 ready; 2 something is BLOCKED; 4 nothing is blocked but a required item is NOT VERIFIED. */
  exitCode: 0 | 2 | 4;
}

const OWNER_ENV = ['EMAIL', 'PASSWORD', 'BUSINESS_ID'].flatMap((n) => (['A', 'B'] as const).map((w) => `ACCEPTANCE_OWNER_${w}_${n}`));

export async function runPreflight(config: TargetsConfig, deps: PreflightDeps, opts: { online: boolean }): Promise<PreflightResult> {
  const items: PreflightItem[] = [];
  const add = (id: string, title: string, status: PreflightStatus, detail: string, required = true) => items.push({ id, title, status, detail, required });
  const hostsApproved = config.approved && config.approvedBy !== null && config.approvedAt !== null;

  // ---- hosts (offline) ----
  add('P01', 'staging hostnames approved by the owner', hostsApproved ? 'PASS' : 'BLOCKED',
    hostsApproved ? 'recorded in staging-targets.json' : `not approved. Needs approval of: ${[config.targets.api.host, config.targets.web.host, config.targets.cashier.host].join(', ')}`);
  const hosts = [config.targets.api.host, config.targets.web.host, config.targets.cashier.host];
  add('P02', 'no configured host is a production host', hosts.some(isProductionHost) ? 'BLOCKED' : 'PASS', hosts.some(isProductionHost) ? 'a configured host is production' : 'all three are staging hosts');
  const api = deps.readRepoFile('api-wrangler');
  const web = deps.readRepoFile('web-wrangler');
  if (api === null || web === null) {
    add('P03', 'hostnames match the repository\'s staging Worker configuration', 'NOT VERIFIED', 'the Worker configuration files could not be read');
  } else {
    const matches = api.includes('name = "echo-grid-feedback-api-staging"') && config.targets.api.host.startsWith('echo-grid-feedback-api-staging.')
      && web.includes(`https://${config.targets.api.host}`) && web.includes(config.targets.web.host) && web.includes(`CASHIER_HOST = "${config.targets.cashier.host}"`);
    add('P03', 'hostnames match the repository\'s staging Worker configuration', matches ? 'PASS' : 'BLOCKED', matches ? 'api, web and cashier hostnames all appear in wrangler.toml' : 'a configured hostname is not in the repository Worker configuration');
  }
  const live = config.liveExecution;
  const liveOk = live.authorized && live.authorizedBy !== null && live.reference !== null;
  add('P04', 'live execution authorized by the owner (separate from the hostnames)', liveOk ? 'PASS' : 'BLOCKED', liveOk ? 'recorded in staging-targets.json' : 'not authorized: needs a separate owner directive recorded in liveExecution');

  // ---- mailbox ----
  const mb = config.mailbox;
  const mailboxApproved = mb.approved && mb.adapter !== 'none' && mb.approvedBy !== null;
  add('P05', 'test mailbox approved by the owner', mailboxApproved ? 'PASS' : 'BLOCKED', mailboxApproved ? `adapter "${mb.adapter}"` : 'no mailbox provider/adapter is approved');
  const factory = mailboxApproved ? deps.adapters[mb.adapter] : undefined;
  add('P06', 'the approved mailbox adapter exists in this build', !mailboxApproved ? 'NOT VERIFIED' : factory ? 'PASS' : 'BLOCKED',
    !mailboxApproved ? 'depends on P05' : factory ? `adapter "${mb.adapter}" is available` : `adapter "${mb.adapter}" is not available in this build (available: ${Object.keys(deps.adapters).join(', ') || 'none'})`);
  if (!mailboxApproved || !factory) {
    add('P07', 'mailbox configuration and credentials present (names only)', 'NOT VERIFIED', 'depends on P05 and P06');
  } else {
    try {
      factory(deps.env, mb);
      add('P07', 'mailbox configuration and credentials present (names only)', 'PASS', 'the adapter accepted its configuration');
    } catch (error) {
      add('P07', 'mailbox configuration and credentials present (names only)', 'BLOCKED', error instanceof HarnessRefusal ? error.message : 'the adapter could not be configured');
    }
  }
  const domainOk = mailboxApproved && mb.allowedRecipientDomains.length > 0;
  add('P08', 'synthetic recipient identity authorized (approved domain for acc-<run>-<label>@domain)', domainOk ? 'PASS' : 'BLOCKED', domainOk ? `${mb.allowedRecipientDomains.length} approved domain(s)` : 'no approved synthetic recipient domain');
  const provOk = config.customerProvisioning.approved && config.customerProvisioning.approvedBy !== null;
  // ---- E2D: receiver-backed adapters. Approving a mailbox does not approve a receiver host; each is its own recorded value. ----
  const receiverAdapter = mb.adapter === 'cloudflare-receiver';
  const appHosts = [config.targets.api.host, config.targets.web.host, config.targets.cashier.host];
  if (!mailboxApproved) {
    add('P16', 'receiver host approved and not production (receiver-backed adapters)', 'NOT VERIFIED', 'depends on P05');
  } else if (!receiverAdapter) {
    add('P16', 'receiver host approved and not production (receiver-backed adapters)', 'PASS', `not applicable: adapter "${mb.adapter}" uses no receiver host`);
  } else if (!mb.receiverHost) {
    add('P16', 'receiver host approved and not production (receiver-backed adapters)', 'BLOCKED', 'no receiver host is approved in mailbox.receiverHost');
  } else if (isProductionHost(mb.receiverHost) || appHosts.includes(mb.receiverHost)) {
    add('P16', 'receiver host approved and not production (receiver-backed adapters)', 'BLOCKED', 'the receiver host is a production host or an application host');
  } else {
    add('P16', 'receiver host approved and not production (receiver-backed adapters)', 'PASS', 'an approved test receiver host is recorded');
  }
  const domainsBad = mb.allowedRecipientDomains.filter((d) => isProductionHost(d) || appHosts.includes(d) || d === mb.receiverHost);
  add('P17', 'recipient isolation configured (synthetic domain is not a production, application or receiver host)', mb.allowedRecipientDomains.length === 0 ? 'NOT VERIFIED' : domainsBad.length === 0 ? 'PASS' : 'BLOCKED',
    mb.allowedRecipientDomains.length === 0 ? 'no recipient domain recorded yet' : domainsBad.length === 0 ? 'only acc-<run>-<label>@<approved domain> can be read' : 'an approved recipient domain collides with a production, application or receiver host');
  add('P09', 'customer provisioning (creating synthetic customers) approved by the owner', provOk ? 'PASS' : 'BLOCKED', provOk ? 'recorded in staging-targets.json' : 'not approved');

  // ---- credentials, tooling ----
  const missingEnv = OWNER_ENV.filter((n) => !deps.env[n]);
  add('P10', 'staging owner credentials present for businesses A and B (names only)', missingEnv.length === 0 ? 'PASS' : 'BLOCKED', missingEnv.length === 0 ? 'all six variables are set' : `missing: ${missingEnv.join(', ')}`);
  const browser = await deps.browser();
  add('P11', 'browser automation ready', browser.ok ? 'PASS' : 'BLOCKED', browser.detail);
  const driver = deps.driverPresent();
  add('P12', 'the real customer sign-up driver is present in this build', driver ? 'PASS' : 'BLOCKED', driver ? 'apps/web/e2e/acceptance/signup-driver.ts' : 'not found');

  // ---- live checks: only when the owner has approved hosts AND live execution, and --online was asked for ----
  const mayProbe = hostsApproved && liveOk && !hosts.some(isProductionHost) && opts.online;
  const why = !opts.online ? 'not requested (offline preflight)' : !hostsApproved ? 'not performed: hostnames are not approved' : !liveOk ? 'not performed: live execution is not authorized' : '';
  if (!mayProbe) {
    add('P13', 'staging Workers reachable (api, web, cashier)', 'NOT VERIFIED', why);
    add('P14', 'the API reports environment "staging" at /health', 'NOT VERIFIED', why);
  } else {
    const targets = guardTargets(config, { requireApproval: true });
    const probe = async (url: string): Promise<boolean> => {
      try {
        const res = await deps.fetch(assertAllowedUrl(targets, url).toString(), { method: 'GET', redirect: 'manual' });
        return res.status < 500;
      } catch {
        return false;
      }
    };
    const up = await Promise.all([probe(`https://${config.targets.api.host}/health`), probe(`https://${config.targets.web.host}/loyalty/signup`), probe(`https://${config.targets.cashier.host}/cashier/login`)]);
    const names = ['api', 'web', 'cashier'];
    const down = names.filter((_, i) => !up[i]);
    add('P13', 'staging Workers reachable (api, web, cashier)', down.length === 0 ? 'PASS' : 'BLOCKED', down.length === 0 ? 'all three answered' : `not reachable: ${down.join(', ')}`);
    try {
      await verifyStagingIdentity(deps.fetch, targets);
      add('P14', 'the API reports environment "staging" at /health', 'PASS', 'environment: staging');
    } catch {
      add('P14', 'the API reports environment "staging" at /health', 'BLOCKED', 'the staging identity could not be established');
    }
  }
  add('P15', 'CLIENT_ATTRIBUTION_SECRET present on the API, web and cashier Workers (D1)', 'NOT VERIFIED',
    'Worker secret names cannot be read by this harness; the owner confirms by name (wrangler secret list). Advisory: absence degrades sign-in rate limiting, it does not weaken authentication.', false);

  const blocked = items.some((i) => i.status === 'BLOCKED');
  const unverifiedRequired = items.some((i) => i.required && i.status === 'NOT VERIFIED');
  const ready = !blocked && !unverifiedRequired;
  return { items, verdict: ready ? 'READY' : 'NOT READY', exitCode: ready ? 0 : blocked ? 2 : 4 };
}
