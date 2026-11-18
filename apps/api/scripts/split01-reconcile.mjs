/**
 * Split 01 reconciliation: read-only invariant counts for the identity and
 * customer-relationship model (global customer -> business membership ->
 * loyalty account).
 *
 *   DATABASE_URL=postgresql://... node apps/api/scripts/split01-reconcile.mjs
 *
 * Safety properties:
 *  - the whole run is a single READ ONLY transaction that is always rolled back;
 *  - only counts are selected and printed, never customer rows or personal data;
 *  - the connection string is never printed (only current_database());
 *  - a statement timeout bounds the work on a large database.
 *
 * Exit codes: 0 every invariant holds, 1 at least one invariant is violated,
 * 2 the check could not run (missing DATABASE_URL, connection or SQL failure).
 *
 * This is the "reconciliation" that Split 01's Definition of Done requires for
 * the 0034 backfill. It is not the Drizzle metadata reconciliation that the
 * original completion report refers to.
 */
import { pathToFileURL } from 'node:url';
import pg from 'pg';

/** Seven invariant counts plus three informational totals; one row, counts only. */
export const RECONCILIATION_SQL = `
SELECT
  (SELECT count(*) FROM loyalty_accounts)::int AS accounts_total,
  (SELECT count(*) FROM business_customer_memberships)::int AS memberships_total,
  (SELECT count(*) FROM business_customer_memberships WHERE onboarding_source = 'legacy_migration')::int AS legacy_memberships,
  (SELECT count(*) FROM loyalty_accounts WHERE membership_id IS NULL)::int AS accounts_without_membership,
  (SELECT count(*) FROM loyalty_accounts la
     JOIN business_customer_memberships m ON m.id = la.membership_id
    WHERE m.customer_id <> la.customer_id OR m.business_id <> la.business_id)::int AS mapping_mismatch,
  (SELECT count(*) FROM loyalty_accounts la
     JOIN business_customer_memberships m ON m.id = la.membership_id
    WHERE la.is_deleted AND m.status = 'active')::int AS deleted_account_active_membership,
  (SELECT count(*) FROM loyalty_accounts la
     JOIN business_customer_memberships m ON m.id = la.membership_id
    WHERE (la.status = 'suspended') <> (m.status = 'suspended'))::int AS status_disagreement,
  (SELECT count(*) FROM business_customer_memberships m
    WHERE NOT EXISTS (SELECT 1 FROM loyalty_accounts la WHERE la.membership_id = m.id))::int AS memberships_without_account,
  (SELECT count(*) FROM business_customer_memberships m
    WHERE m.status = 'active'
      AND m.onboarding_source IS DISTINCT FROM 'legacy_migration'
      AND NOT EXISTS (
        SELECT 1 FROM consent_grants g
         WHERE g.customer_id = m.customer_id AND g.business_id = m.business_id
           AND g.purpose = 'join_loyalty' AND g.status = 'active'))::int AS joined_without_active_consent,
  (SELECT count(*) FROM business_customer_memberships m
    WHERE m.status = 'left'
      AND EXISTS (
        SELECT 1 FROM consent_grants g
         WHERE g.customer_id = m.customer_id AND g.business_id = m.business_id
           AND g.purpose = 'join_loyalty' AND g.status = 'active'))::int AS left_with_active_consent
`;

/** Counts that must be zero, with what a non-zero value means for an operator. */
export const ZERO_INVARIANTS = Object.freeze({
  accounts_without_membership:
    'Loyalty accounts with no membership_id: the 0034 backfill or a later enrollment did not link them.',
  mapping_mismatch:
    'Loyalty accounts linked to a membership that belongs to a different customer or business.',
  deleted_account_active_membership:
    'Soft-deleted loyalty accounts whose membership is still active: the 0034 backfill has no is_deleted filter. Review each row before acting.',
  status_disagreement:
    'Accounts and memberships disagree on whether the relationship is suspended.',
  memberships_without_account:
    'Memberships that have no loyalty account (a join that created only half of the pair).',
  joined_without_active_consent:
    'Active memberships created after the migration that have no active join_loyalty consent grant.',
  left_with_active_consent:
    'Memberships that have left but still hold an active join_loyalty consent (withdrawal did not complete).',
});

/** @param {Record<string, number>} counts */
export function evaluateCounts(counts) {
  return Object.entries(ZERO_INVARIANTS)
    .filter(([key]) => Number(counts[key]) !== 0)
    .map(([key, meaning]) => ({ check: key, count: Number(counts[key]), meaning }));
}

/**
 * Runs the reconciliation inside one READ ONLY transaction on `client`, which
 * is always rolled back.
 * @param {{ query: (text: string) => Promise<{ rows: Record<string, unknown>[] }> }} client
 */
export async function runReconciliation(client) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const database = String(
      (await client.query('SELECT current_database() AS name')).rows[0]?.name,
    );
    const row = (await client.query(RECONCILIATION_SQL)).rows[0] ?? {};
    const counts = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Number(value)]),
    );
    const violations = evaluateCounts(counts);
    return {
      database,
      checkedAt: new Date().toISOString(),
      ok: violations.length === 0,
      counts,
      violations,
    };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('split01-reconcile: DATABASE_URL is required.');
    return 2;
  }
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const result = await runReconciliation(client);
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  } catch (error) {
    // Never echo the connection string; the driver error is enough to diagnose.
    console.error(
      `split01-reconcile: could not complete the check (${error instanceof Error ? error.message : 'unknown error'}).`,
    );
    return 2;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
