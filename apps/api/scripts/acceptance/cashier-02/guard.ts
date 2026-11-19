/**
 * CASHIER-AUTH-02E E1: the staging-only safety boundary of the acceptance harness.
 *
 * Everything the harness may talk to is decided HERE, from a reviewed, committed configuration file, never from the
 * command line or the environment. A live run needs (1) every host on the fixed allow-list, (2) none on the production
 * deny-list, (3) the owner's recorded approval inside the configuration file, and (4) the API itself reporting
 * `environment: "staging"` from `/health`. There is no override flag; any attempt to supply a host is refused.
 */

export type RefusalCode =
  | 'CONFIG_INVALID'
  | 'URL_MALFORMED'
  | 'HOST_NOT_ALLOWED'
  | 'HOST_PRODUCTION'
  | 'OVERRIDE_REJECTED'
  | 'LIVE_NOT_APPROVED'
  | 'STAGING_IDENTITY'
  | 'MAILBOX_NOT_APPROVED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'OTP_REFUSED';

/** A refusal is a safe, expected stop: nothing was sent. Messages never contain secrets or user-supplied values verbatim. */
export class HarnessRefusal extends Error {
  readonly code: RefusalCode;
  constructor(code: RefusalCode, message: string) {
    super(message);
    this.name = 'HarnessRefusal';
    this.code = code;
  }
}

export interface MailboxConfig {
  approved: boolean;
  approvedBy: string | null;
  adapter: string;
  allowedRecipientDomains: string[];
}

export interface TargetsConfig {
  version: 1;
  approved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  targets: { api: { host: string }; web: { host: string }; cashier: { host: string } };
  mailbox: MailboxConfig;
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Hosts that are production by construction. The allow-list is exact-match and is the real control; this list exists so a
 * mistake in the configuration file (or a future edit) fails loudly instead of quietly pointing the harness at production.
 */
export function isProductionHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'echo-grid.uk' ||
    h.endsWith('.echo-grid.uk') ||
    /^echo-grid-feedback-(api|web|cashier)\.[a-z0-9-]+\.workers\.dev$/.test(h) ||
    /(^|[.-])(prod|production|live)([.-]|$)/.test(h)
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HarnessRefusal('CONFIG_INVALID', `${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseHost(value: unknown, what: string): string {
  if (typeof value !== 'string' || !HOST_PATTERN.test(value) || value !== value.toLowerCase()) {
    throw new HarnessRefusal('CONFIG_INVALID', `${what} must be a lowercase DNS host name.`);
  }
  if (isProductionHost(value)) throw new HarnessRefusal('HOST_PRODUCTION', `${what} is a production host.`);
  if (!/-staging$/.test(value.split('.')[0] ?? '')) {
    throw new HarnessRefusal('CONFIG_INVALID', `${what} must be a staging host (its name must end in "-staging").`);
  }
  return value;
}

/** Validates the committed configuration. It is never built from user input. */
export function parseTargetsConfig(raw: unknown): TargetsConfig {
  const root = asRecord(raw, 'configuration');
  if (root.version !== 1) throw new HarnessRefusal('CONFIG_INVALID', 'Unsupported configuration version.');
  if (typeof root.approved !== 'boolean') throw new HarnessRefusal('CONFIG_INVALID', '"approved" must be a boolean.');
  const approver = (value: unknown, what: string): string | null => {
    if (value === null) return null;
    if (typeof value === 'string' && value.trim().length > 0) return value;
    throw new HarnessRefusal('CONFIG_INVALID', `${what} must be null or a non-empty string.`);
  };
  const targets = asRecord(root.targets, 'targets');
  const host = (key: 'api' | 'web' | 'cashier') =>
    parseHost(asRecord(targets[key], `targets.${key}`).host, `targets.${key}.host`);
  const hosts = { api: host('api'), web: host('web'), cashier: host('cashier') };
  if (new Set(Object.values(hosts)).size !== 3) {
    throw new HarnessRefusal('CONFIG_INVALID', 'The three staging hosts must be distinct.');
  }
  const mailbox = asRecord(root.mailbox, 'mailbox');
  if (typeof mailbox.approved !== 'boolean' || typeof mailbox.adapter !== 'string') {
    throw new HarnessRefusal('CONFIG_INVALID', 'mailbox.approved and mailbox.adapter are required.');
  }
  const domains = mailbox.allowedRecipientDomains;
  if (!Array.isArray(domains) || domains.some((d) => typeof d !== 'string' || !HOST_PATTERN.test(d) || d !== d.toLowerCase())) {
    throw new HarnessRefusal('CONFIG_INVALID', 'mailbox.allowedRecipientDomains must be a list of lowercase domains.');
  }
  if (mailbox.approved && (mailbox.adapter === 'none' || domains.length === 0 || approver(mailbox.approvedBy, 'mailbox.approvedBy') === null)) {
    throw new HarnessRefusal('CONFIG_INVALID', 'An approved mailbox needs an adapter, allowed domains and an approver.');
  }
  const approvedBy = approver(root.approvedBy, 'approvedBy');
  const approvedAt = approver(root.approvedAt, 'approvedAt');
  if (root.approved && (approvedBy === null || approvedAt === null)) {
    throw new HarnessRefusal('CONFIG_INVALID', 'An approved configuration records who approved it and when.');
  }
  return {
    version: 1,
    approved: root.approved,
    approvedBy,
    approvedAt,
    targets: { api: { host: hosts.api }, web: { host: hosts.web }, cashier: { host: hosts.cashier } },
    mailbox: {
      approved: mailbox.approved,
      approvedBy: approver(mailbox.approvedBy, 'mailbox.approvedBy'),
      adapter: mailbox.adapter,
      allowedRecipientDomains: [...(domains as string[])],
    },
  };
}

declare const guardedBrand: unique symbol;

/** The only handle the HTTP client accepts. It can only be produced by {@link guardTargets}. */
export interface GuardedTargets {
  readonly [guardedBrand]: true;
  readonly apiBase: string;
  readonly allowedHosts: readonly string[];
}

/**
 * Builds the guarded targets. `requireApproval` is true for every live run; it is false only for the offline self-check,
 * which makes no request. Never returns a handle for an unapproved configuration when approval is required.
 */
export function guardTargets(config: TargetsConfig, opts: { requireApproval: boolean }): GuardedTargets {
  const hosts = [config.targets.api.host, config.targets.web.host, config.targets.cashier.host];
  for (const host of hosts) {
    if (isProductionHost(host)) throw new HarnessRefusal('HOST_PRODUCTION', 'A configured host is a production host.');
  }
  if (opts.requireApproval && !(config.approved && config.approvedBy !== null && config.approvedAt !== null)) {
    throw new HarnessRefusal(
      'LIVE_NOT_APPROVED',
      'Live execution is disabled: the staging hostnames in staging-targets.json have not been approved by the owner.',
    );
  }
  return { apiBase: `https://${config.targets.api.host}/api/v1`, allowedHosts: hosts } as unknown as GuardedTargets;
}

/** Defence in depth: every outbound URL is re-checked, so a bug elsewhere cannot reach another host. */
export function assertAllowedUrl(targets: GuardedTargets, rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HarnessRefusal('URL_MALFORMED', 'The request URL is not valid.');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') {
    throw new HarnessRefusal('URL_MALFORMED', 'Only plain https URLs on the default port without credentials are allowed.');
  }
  if (isProductionHost(url.hostname)) throw new HarnessRefusal('HOST_PRODUCTION', 'The request targets a production host.');
  if (!targets.allowedHosts.includes(url.hostname)) {
    throw new HarnessRefusal('HOST_NOT_ALLOWED', 'The request host is not on the staging allow-list.');
  }
  return url;
}

const OVERRIDE_FLAG = /^--?(api|web|cashier|base|host|hostname|url|target|origin|endpoint|server|env-file)\b/i;
const OVERRIDE_ENV = /^(ACCEPTANCE_)?(API|WEB|CASHIER|BASE|TARGET|STAGING)[_-]?(URL|HOST|HOSTNAME|ORIGIN|ENDPOINT)$/i;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** User-provided host overrides are rejected outright (flag, environment variable, or a URL-looking value). */
export function assertNoHostOverrides(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): void {
  for (const arg of argv) {
    if (OVERRIDE_FLAG.test(arg) || URL_LIKE.test(arg.replace(/^--[^=]+=/, ''))) {
      throw new HarnessRefusal('OVERRIDE_REJECTED', 'Host overrides are not supported; targets come only from staging-targets.json.');
    }
  }
  for (const key of Object.keys(env)) {
    if (OVERRIDE_ENV.test(key) && env[key] !== undefined && env[key] !== '') {
      throw new HarnessRefusal('OVERRIDE_REJECTED', 'Host override environment variables are not supported.');
    }
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** The API must say it is staging. If it cannot be asked, or says anything else, the run does not start. */
export async function verifyStagingIdentity(fetchFn: FetchFn, targets: GuardedTargets): Promise<void> {
  const healthUrl = assertAllowedUrl(targets, `${targets.apiBase.replace(/\/api\/v1$/, '')}/health`);
  let body: unknown;
  try {
    const res = await fetchFn(healthUrl.toString(), { method: 'GET', redirect: 'error' });
    if (res.status !== 200) throw new Error('status');
    body = await res.json();
  } catch {
    throw new HarnessRefusal('STAGING_IDENTITY', 'The staging identity could not be established from the API health endpoint.');
  }
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (record.environment !== 'staging' || record.service !== 'echo-grid-feedback-api' || record.status !== 'ok') {
    throw new HarnessRefusal('STAGING_IDENTITY', 'The API did not identify itself as the staging environment.');
  }
}
