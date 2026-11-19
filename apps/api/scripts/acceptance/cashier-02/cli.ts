import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveClient } from './client';
import {
  HarnessRefusal, assertNoHostOverrides, guardTargets, parseTargetsConfig, verifyStagingIdentity, type FetchFn, type TargetsConfig,
} from './guard';
import { ingestPlaywrightReport, type BrowserCheck } from './browser-results';
import { createPacer } from './pace';
import { LiveCustomerProvisioner, missingApprovals, type SignupDriver } from './provisioner';
import { createVerificationMailbox, type MessageSourceFactory } from './verification-mailbox';
import { redactString } from './redact';
import { exitCodeFor, runAcceptance } from './runner';
import { SCENARIOS, type Context, type OwnerCredentials } from './scenarios';

/**
 * Usage (from apps/api):
 *   pnpm acceptance:cashier-02                 offline self-check: validates the configuration, runs nothing, makes no request
 *   pnpm acceptance:cashier-02 -- --env staging [--scenarios S01,S02] [--out DIR] [--require-all] [--browser-results FILE]
 *
 * Live execution is DISABLED until the owner records the approval of the staging hostnames in staging-targets.json.
 * Exit codes: 0 all runnable checks passed, 1 a check failed (or NOT RUN with --require-all), 2 blocked by a safety refusal, 3 interrupted.
 */
export interface CliIo {
  log(line: string): void;
  fetch: FetchFn;
  readConfig(): unknown;
  commit(): string;
  signal?: AbortSignal;
  /** E2-A: the real sign-up driver (a browser). Only consulted when all three approvals are recorded. */
  signupDriver?: (target: { webHost: string }) => Promise<SignupDriver>;
  /** E2-B: mailbox adapters available in this build. None ships; tests inject fixtures. */
  mailboxAdapters?: Readonly<Record<string, MessageSourceFactory>>;
  /** E2-D: reads the Playwright JSON report named by --browser-results. */
  readReport?: (file: string) => unknown;
}

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'staging-targets.json');

export const defaultIo = (signal?: AbortSignal): CliIo => ({
  log: (line) => process.stdout.write(`${redactString(line)}\n`),
  fetch: (url, init) => fetch(url, init),
  readConfig: () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown,
  commit: () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return process.env.GITHUB_SHA ?? 'unknown'; }
  },
  readReport: (file) => JSON.parse(readFileSync(file, 'utf8')) as unknown,
  // The real sign-up driver is a browser and lives in the web package's browser tier. Loaded only when all three approvals are recorded.
  signupDriver: async ({ webHost }) => {
    const modulePath = new URL('../../../../web/e2e/acceptance/signup-driver.ts', import.meta.url).href;
    const mod = (await import(modulePath)) as { createSignupDriver(opts: { webHost: string }): SignupDriver };
    return mod.createSignupDriver({ webHost });
  },
  ...(signal ? { signal } : {}),
});

const ENV_NAMES = ['EMAIL', 'PASSWORD', 'BUSINESS_ID'] as const;

function ownerFromEnv(env: Readonly<Record<string, string | undefined>>, which: 'A' | 'B'): OwnerCredentials {
  const missing = ENV_NAMES.filter((n) => !env[`ACCEPTANCE_OWNER_${which}_${n}`]).map((n) => `ACCEPTANCE_OWNER_${which}_${n}`);
  if (missing.length > 0) throw new HarnessRefusal('CONFIG_INVALID', `Missing environment variables (names only): ${missing.join(', ')}.`);
  return { email: env[`ACCEPTANCE_OWNER_${which}_EMAIL`] as string, password: env[`ACCEPTANCE_OWNER_${which}_PASSWORD`] as string, businessId: env[`ACCEPTANCE_OWNER_${which}_BUSINESS_ID`] as string };
}

function selfCheck(config: TargetsConfig, io: CliIo): number {
  guardTargets(config, { requireApproval: false });
  io.log('CASHIER-AUTH-02E acceptance harness: offline self-check (no request is made)');
  io.log(`staging hostnames approved by the owner: ${config.approved ? 'YES' : 'NO (live execution disabled)'}`);
  io.log(`test mailbox approved: ${config.mailbox.approved ? 'YES' : 'NO (verification-dependent scenarios are NOT RUN)'}`);
  io.log(`customer provisioning approved: ${config.customerProvisioning.approved ? 'YES' : 'NO (customer scenarios are NOT RUN)'}`);
  const missing = missingApprovals(config);
  io.log(missing.length === 0 ? 'live customer provisioning: all approvals recorded' : `live customer provisioning: disabled (missing approvals: ${missing.join(', ')})`);
  for (const s of SCENARIOS) io.log(`  ${s.id}  ${s.area}`);
  return 0;
}

export async function runCli(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: CliIo): Promise<number> {
  try {
    assertNoHostOverrides(argv, env);
    const config = parseTargetsConfig(io.readConfig());
    const flag = (name: string) => argv.includes(name);
    const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    const envName = value('--env');
    if (flag('--env') && envName !== 'staging') throw new HarnessRefusal('HOST_NOT_ALLOWED', 'Only the staging environment is supported.');
    if (!flag('--env') || flag('--self-check')) return selfCheck(config, io);

    const targets = guardTargets(config, { requireApproval: true });
    const ownerA = ownerFromEnv(env, 'A');
    const ownerB = ownerFromEnv(env, 'B');
    await verifyStagingIdentity(io.fetch, targets);
    const runId = `${Date.now().toString(36).slice(-5)}${randomBytes(2).toString('hex')}`.slice(0, 9);
    // E2-A/E2-B: customers exist only when ALL three approvals are recorded; an approved mailbox with no adapter in this build is refused.
    let provisioner: LiveCustomerProvisioner | null = null;
    let driverToClose: SignupDriver | undefined;
    if (missingApprovals(config).length === 0) {
      const mailbox = createVerificationMailbox(config.mailbox, { runId, webHost: config.targets.web.host, ...(io.mailboxAdapters ? { adapters: io.mailboxAdapters } : {}), env });
      const driver = await io.signupDriver?.({ webHost: config.targets.web.host });
      if (!driver) throw new HarnessRefusal('PROVISIONER_REFUSED', 'No sign-up driver is available in this build.');
      driverToClose = driver;
      provisioner = new LiveCustomerProvisioner({ runId, config, mailbox, driver });
    }
    // E2-D: browser evidence is accepted only in the mode of this run (staging).
    let browser: BrowserCheck[] | undefined;
    const reportFile = value('--browser-results');
    if (reportFile) {
      if (!io.readReport) throw new HarnessRefusal('CONFIG_INVALID', 'Reading a browser report is not available here.');
      browser = ingestPlaywrightReport(io.readReport(reportFile), 'staging');
    }
    const pacer = createPacer();
    const ctx: Context = { api: createLiveClient(targets, { fetch: io.fetch, pacer }), runId, ownerA, ownerB, provisioner, ...(browser ? { browser } : {}) };
    const only = value('--scenarios')?.split(',').filter(Boolean);
    let outcome: Awaited<ReturnType<typeof runAcceptance>>;
    try {
      outcome = await runAcceptance({
        ctx, mode: 'staging', commit: io.commit(), outDir: value('--out') ?? path.join(process.cwd(), 'acceptance-results', 'cashier-02'), only, signal: io.signal,
      });
    } finally {
      await driverToClose?.close?.().catch(() => undefined);
    }
    const { report, file, interruptedEarlier } = outcome;
    if (interruptedEarlier.length > 0) io.log(`note: ${interruptedEarlier.length} earlier run(s) have a journal but no final report (not touched).`);
    for (const c of report.checks) io.log(`${c.status} ${c.id} ${c.title}${c.status === 'PASS' ? '' : ` :: ${c.detail}`}`);
    io.log(`PASS ${report.counts.pass}  FAIL ${report.counts.fail}  NOT RUN ${report.counts.notRun}  state ${report.state}  hash ${report.reportHash.slice(0, 12)}`);
    if (file) io.log(`result file: ${file}`);
    return exitCodeFor(report, { requireAll: flag('--require-all') });
  } catch (error) {
    if (error instanceof HarnessRefusal) {
      io.log(`BLOCKED (${error.code}): ${error.message}`);
      return 2;
    }
    io.log(`ERROR: ${error instanceof Error ? error.name : 'unexpected error'}`);
    return 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  runCli(process.argv.slice(2), process.env, defaultIo(controller.signal)).then((code) => { process.exitCode = code; });
}
