/* eslint-disable no-console -- operator CLI: stdout is its output channel (JSON only; never key material) */
import { DEFAULT_REQUIRED_EVENT_TYPES, runAttestation, stripeObserver } from '../../src/billing/stripe-evidence';
import { commitSha, connectGuarded, opt, parseArgs } from './_cli';

/**
 * HETA-01-F1 L2 attestation (operator / deploy-time). Usage:
 *   STRIPE_RESTRICTED_READ_KEY=rk_... STRIPE_ACCOUNT_ID=acct_... STRIPE_EXPECTED_LIVEMODE=false \
 *   ATTEST_ENDPOINT_URL=https://<host>/webhooks/stripe ATTEST_APPROVED_API_VERSIONS=2026-05-27.dahlia \
 *   DATABASE_URL=... pnpm evidence:attest -- --expect-database <name> [--dry-run]
 * The key is read from the environment only, never accepted as an argument, never printed. Exit 0 only on `passed`.
 */
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const key = process.env.STRIPE_RESTRICTED_READ_KEY ?? '';
  const accountId = process.env.STRIPE_ACCOUNT_ID ?? '';
  const live = process.env.STRIPE_EXPECTED_LIVEMODE;
  const dryRun = a.flags.has('dry-run');
  const expectation = {
    accountId, livemode: live === 'true', endpointUrl: process.env.ATTEST_ENDPOINT_URL ?? '',
    approvedApiVersions: (process.env.ATTEST_APPROVED_API_VERSIONS ?? '').split(',').map(s => s.trim()).filter(Boolean),
    requiredEventTypes: (process.env.ATTEST_REQUIRED_EVENT_TYPES ?? DEFAULT_REQUIRED_EVENT_TYPES.join(',')).split(',').map(s => s.trim()).filter(Boolean),
  };
  if (live !== 'true' && live !== 'false') throw new Error('STRIPE_EXPECTED_LIVEMODE must be "true" or "false" (never inferred)');
  const conn = dryRun && !opt(a, 'expect-database') ? null : await connectGuarded(opt(a, 'expect-database') ?? (() => { throw new Error('missing required --expect-database'); })());
  try {
    const out = await runAttestation({
      db: conn!.db, observe: stripeObserver(key), expectation, commitSha: commitSha(), actor: `operator:attest:${process.env.USER ?? 'unknown'}`, dryRun,
    });
    console.log(JSON.stringify({ result: out.result, failures: out.failures, stream: out.stream, recorded: out.recorded, dryRun }, null, 2));
    process.exitCode = out.result === 'passed' ? 0 : 2;
  } finally {
    await conn?.close();
  }
}

main().catch(e => { console.error('attestation script error:', e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
