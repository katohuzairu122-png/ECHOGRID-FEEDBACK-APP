import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLiveClient } from './client';
import {
  HarnessRefusal, assertNoHostOverrides, guardTargets, parseTargetsConfig, verifyStagingIdentity, type FetchFn, type TargetsConfig,
} from './guard';
import { createMailbox } from './mailbox';
import { createPacer } from './pace';
import { redactString } from './redact';
import { exitCodeFor, runAcceptance } from './runner';
import { SCENARIOS, type Context, type OwnerCredentials } from './scenarios';

/**
 * Usage (from apps/api):
 *   pnpm acceptance:cashier-02                 offline self-check: validates the configuration, runs nothing, makes no request
 *   pnpm acceptance:cashier-02 -- --env staging [--scenarios S01,S02] [--out DIR] [--require-all]
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
}

const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'staging-targets.json');

export const defaultIo = (signal?: AbortSignal): CliIo => ({
  log: (line) => process.stdout.write(`${redactString(line)}\n`),
  fetch: (url, init) => fetch(url, init),
  readConfig: () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as unknown,
  commit: () => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { return process.env.GITHUB_SHA ?? 'unknown'; }
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
  io.log(`test mailbox approved: ${config.mailbox.approved ? 'YES' : 'NO (OTP-dependent scenarios are NOT RUN)'}`);
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
    // The mailbox contract is wired, but no adapter ships with E1: an approved mailbox without an adapter is refused here.
    createMailbox(config.mailbox, runId);
    const pacer = createPacer();
    const ctx: Context = { api: createLiveClient(targets, { fetch: io.fetch, pacer }), runId, ownerA, ownerB, provisioner: null };
    const only = value('--scenarios')?.split(',').filter(Boolean);
    const { report, file, interruptedEarlier } = await runAcceptance({
      ctx, mode: 'staging', commit: io.commit(), outDir: value('--out') ?? path.join(process.cwd(), 'acceptance-results', 'cashier-02'), only, signal: io.signal,
    });
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
