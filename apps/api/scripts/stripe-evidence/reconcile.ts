/* eslint-disable no-console -- operator CLI: stdout is its output channel (JSON only; never key material or payloads) */
import { readFileSync } from 'node:fs';
import { loadKeyring, runReconciliation, stripeFetchSource, StripeEvidenceStore } from '../../src/billing/stripe-evidence';
import { commitSha, connectGuarded, need, opt, parseArgs } from './_cli';

/**
 * HETA-01-F1 windowed reconciliation / backfill (operator, privileged). Usage:
 *   STRIPE_RESTRICTED_READ_KEY=rk_... STRIPE_ACCOUNT_ID=acct_... STRIPE_EXPECTED_LIVEMODE=false \
 *   EVIDENCE_KEK_KEYRING_FILE=/path/keyring.json EVIDENCE_RETENTION_POLICY_VERSION=v1 EVIDENCE_RETENTION_DAYS=365 DATABASE_URL=... \
 *   pnpm evidence:reconcile -- --from <ISO> --to <ISO> --expect-database <name> [--page-size 100 --max-pages 10 --max-events 1000 --types a,b] [--dry-run]
 * A dry run lists and compares only. Exit 0 only for `reconciled_no_known_gaps` (or dry_run); that state is NOT a claim of
 * complete provider history and never certifies the window.
 */
async function main() {
  const a = parseArgs(process.argv.slice(2));
  const live = process.env.STRIPE_EXPECTED_LIVEMODE;
  if (live !== 'true' && live !== 'false') throw new Error('STRIPE_EXPECTED_LIVEMODE must be "true" or "false" (never inferred)');
  const accountId = process.env.STRIPE_ACCOUNT_ID ?? '';
  if (!/^acct_[A-Za-z0-9]+$/.test(accountId)) throw new Error('STRIPE_ACCOUNT_ID is missing or malformed');
  const key = process.env.STRIPE_RESTRICTED_READ_KEY ?? '';
  if (!key.startsWith('rk_')) throw new Error('STRIPE_RESTRICTED_READ_KEY must be a restricted (rk_) read-only key');
  const days = Number(process.env.EVIDENCE_RETENTION_DAYS);
  const policy = process.env.EVIDENCE_RETENTION_POLICY_VERSION;
  if (!policy || !Number.isInteger(days) || days < 1) throw new Error('retention policy version and days must be set (no default is assumed)');
  const dryRun = a.flags.has('dry-run');
  const now = new Date();
  const keyringFile = process.env.EVIDENCE_KEK_KEYRING_FILE;
  if (!keyringFile) throw new Error('EVIDENCE_KEK_KEYRING_FILE is required (the secret value is read from a file, never an argument)');
  const keyring = await loadKeyring(readFileSync(keyringFile, 'utf8'), now);
  const conn = await connectGuarded(need(a, 'expect-database'));
  try {
    const store = new StripeEvidenceStore(conn.db, { receivingAccountId: accountId, keyring, now: () => new Date() });
    const types = opt(a, 'types')?.split(',').map(s => s.trim()).filter(Boolean);
    const result = await runReconciliation(
      {
        db: conn.db, store, source: stripeFetchSource(key), receivingAccountId: accountId, livemode: live === 'true',
        retention: { policyVersion: policy, retainUntil: new Date(now.getTime() + days * 86_400_000) },
        actor: `operator:reconcile:${process.env.USER ?? 'unknown'}`, commitSha: commitSha(),
      },
      {
        windowStart: new Date(need(a, 'from')), windowEnd: new Date(need(a, 'to')), pageSize: Number(opt(a, 'page-size') ?? 100),
        maxPages: Number(opt(a, 'max-pages') ?? 10), maxEvents: Number(opt(a, 'max-events') ?? 1000), types, dryRun,
      },
    );
    console.log(JSON.stringify({ ...result, dryRun }, null, 2));
    process.exitCode = result.state === 'reconciled_no_known_gaps' || result.state === 'dry_run' ? 0 : 2;
  } finally {
    await conn.close();
  }
}

main().catch(e => { console.error('reconcile script error:', e instanceof Error ? `${e.name}: ${e.message}` : String(e)); process.exitCode = 1; });
