/**
 * CUSTOMER-EMAIL-AUTH-POLICY-01: READ-ONLY readiness check of a database before customer email sign-up is activated.
 *
 *   CUSTOMER_EMAIL_AUTH_READINESS=READ_ONLY_CHECK DATABASE_URL=<read-only connection> \
 *     pnpm --filter @echo-grid-feedback/api exec tsx scripts/customer-email-auth-readiness.ts
 *
 * Guarantees: only SELECT / SHOW statements; the transaction is opened READ ONLY and the database is asked to confirm it before
 * anything is counted; it is rolled back at the end; nothing is written, migrated or locked. The output is COUNTS AND FLAGS
 * ONLY: no customer, email, phone, token or connection detail. It refuses to run without the explicit guard variable.
 *
 * Exit code: 0 = ready, 3 = not ready (the report says why), 2 = refused or failed.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Queryable = { query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> };

export type Expected = { migrationCount: number; lastMigrationWhen: number };

export type ReadinessReport = {
  migrationsApplied: number | null;
  repositoryMigrationCount: number;
  lastAppliedMatchesRepository: boolean | null;
  customersQrRevocationEpochColumn: boolean;
  phoneVerifiedUniqueIndex: boolean;
  legacyGlobalPhoneConstraintPresent: boolean;
  credentialsTablePresent: boolean;
  credentialsWithNullLegacyCutoff: number | null;
  credentialsWithVerifiedLoginEmail: number | null;
};

/** Every statement this tool may issue. A test asserts none of them can write. */
export const STATEMENTS = {
  begin: 'BEGIN READ ONLY',
  confirmReadOnly: 'SHOW transaction_read_only',
  migrationsTable: "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  migrationsApplied: 'SELECT count(*)::int AS n, max(created_at)::bigint AS last_when FROM drizzle.__drizzle_migrations',
  qrColumn: "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customers' AND column_name = 'qr_revocation_epoch') AS present",
  verifiedIndex: "SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'customers_phone_verified_unique') AS present",
  oldConstraint: "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_phone_unique') AS present",
  credentialsColumns: "SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'customer_credentials' AND column_name IN ('legacy_tokens_invalid_before', 'login_email_verified_at')",
  nullCutoff: 'SELECT count(*)::int AS n FROM customer_credentials WHERE legacy_tokens_invalid_before IS NULL',
  verifiedEmail: 'SELECT count(*)::int AS n FROM customer_credentials WHERE login_email_verified_at IS NOT NULL',
  rollback: 'ROLLBACK',
} as const;

const first = (r: { rows: Array<Record<string, unknown>> }) => r.rows[0] ?? {};

export async function collectReadiness(client: Queryable, expected: Expected): Promise<ReadinessReport> {
  await client.query(STATEMENTS.begin);
  try {
    const mode = String(first(await client.query(STATEMENTS.confirmReadOnly)).transaction_read_only ?? '');
    if (mode !== 'on') throw new Error('READ_ONLY_NOT_CONFIRMED');

    let migrationsApplied: number | null = null;
    let lastMatches: boolean | null = null;
    if (first(await client.query(STATEMENTS.migrationsTable)).present === true) {
      const row = first(await client.query(STATEMENTS.migrationsApplied));
      migrationsApplied = Number(row.n);
      lastMatches = Number(row.last_when) === expected.lastMigrationWhen;
    }
    const flag = async (sql: string) => first(await client.query(sql)).present === true;
    const qrColumn = await flag(STATEMENTS.qrColumn);
    const verifiedIndex = await flag(STATEMENTS.verifiedIndex);
    const oldConstraint = await flag(STATEMENTS.oldConstraint);

    const haveCredentialColumns = Number(first(await client.query(STATEMENTS.credentialsColumns)).n) === 2;
    const count = async (sql: string) => Number(first(await client.query(sql)).n);
    return {
      migrationsApplied,
      repositoryMigrationCount: expected.migrationCount,
      lastAppliedMatchesRepository: lastMatches,
      customersQrRevocationEpochColumn: qrColumn,
      phoneVerifiedUniqueIndex: verifiedIndex,
      legacyGlobalPhoneConstraintPresent: oldConstraint,
      credentialsTablePresent: haveCredentialColumns,
      credentialsWithNullLegacyCutoff: haveCredentialColumns ? await count(STATEMENTS.nullCutoff) : null,
      credentialsWithVerifiedLoginEmail: haveCredentialColumns ? await count(STATEMENTS.verifiedEmail) : null,
    };
  } finally {
    await client.query(STATEMENTS.rollback).catch(() => undefined);
  }
}

/** Ready only when the schema matches the repository AND no existing customer would lose their legacy session. */
export function problems(report: ReadinessReport): string[] {
  const out: string[] = [];
  if (report.migrationsApplied === null) out.push('migration history table not found');
  else if (report.migrationsApplied !== report.repositoryMigrationCount) {
    out.push(`migrations applied ${report.migrationsApplied} but the repository defines ${report.repositoryMigrationCount}`);
  }
  if (report.lastAppliedMatchesRepository === false) out.push('the last applied migration does not match the repository journal');
  if (!report.customersQrRevocationEpochColumn) out.push('customers.qr_revocation_epoch is missing (migration 0078)');
  if (!report.phoneVerifiedUniqueIndex) out.push('customers_phone_verified_unique is missing (migration 0079)');
  if (report.legacyGlobalPhoneConstraintPresent) out.push('the old global customers_phone_unique constraint is still present (migration 0079)');
  if (!report.credentialsTablePresent) out.push('customer_credentials is missing the expected columns');
  else if ((report.credentialsWithNullLegacyCutoff ?? 0) > 0) {
    out.push(`${report.credentialsWithNullLegacyCutoff} credential(s) have no legacy cutoff: their legacy sessions would stop working when the flag is on`);
  }
  return out;
}

export const isReady = (report: ReadinessReport) => problems(report).length === 0;

export function formatReport(report: ReadinessReport): string {
  const issues = problems(report);
  return [
    'CUSTOMER EMAIL AUTH READINESS (read-only; counts only)',
    `  migrations applied / repository : ${report.migrationsApplied ?? 'unknown'} / ${report.repositoryMigrationCount}`,
    `  last applied matches repository : ${report.lastAppliedMatchesRepository ?? 'unknown'}`,
    `  customers.qr_revocation_epoch   : ${report.customersQrRevocationEpochColumn ? 'present' : 'MISSING'}`,
    `  verified-phone unique index     : ${report.phoneVerifiedUniqueIndex ? 'present' : 'MISSING'}`,
    `  old global phone constraint     : ${report.legacyGlobalPhoneConstraintPresent ? 'STILL PRESENT' : 'gone'}`,
    `  credentials, null legacy cutoff : ${report.credentialsWithNullLegacyCutoff ?? 'n/a'}   (must be 0)`,
    `  credentials, verified email     : ${report.credentialsWithVerifiedLoginEmail ?? 'n/a'}   (informational)`,
    issues.length === 0 ? 'RESULT: READY' : `RESULT: NOT READY\n${issues.map((i) => `  - ${i}`).join('\n')}`,
  ].join('\n');
}

async function main(): Promise<number> {
  if (process.env.CUSTOMER_EMAIL_AUTH_READINESS !== 'READ_ONLY_CHECK' || !process.env.DATABASE_URL) {
    console.error('Refused: set CUSTOMER_EMAIL_AUTH_READINESS=READ_ONLY_CHECK and DATABASE_URL (a read-only connection).');
    return 2;
  }
  const journalPath = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle/meta/_journal.json');
  const entries = (JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: Array<{ when: number }> }).entries;
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 15_000,
    query_timeout: 15_000,
    options: '-c default_transaction_read_only=on',
  });
  try {
    await client.connect();
    const report = await collectReadiness(client, { migrationCount: entries.length, lastMigrationWhen: entries.at(-1)!.when });
    console.log(formatReport(report));
    return isReady(report) ? 0 : 3;
  } catch (error) {
    console.error(`Failed: ${error instanceof Error ? error.message : 'unknown error'}`); // never print the connection string
    return 2;
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().then((code) => process.exit(code));
}
