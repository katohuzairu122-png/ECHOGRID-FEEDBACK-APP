import { describe, expect, it } from 'vitest';
import {
  STATEMENTS,
  collectReadiness,
  formatReport,
  isReady,
  problems,
  type Queryable,
  type ReadinessReport,
} from '../../scripts/customer-email-auth-readiness';

const EXPECTED = { migrationCount: 12, lastMigrationWhen: 1_700_000_000_000 };

type Plan = Partial<Record<keyof typeof STATEMENTS, Array<Record<string, unknown>>>>;
function fake(plan: Plan = {}) {
  const issued: string[] = [];
  const bySql = new Map<string, Array<Record<string, unknown>>>();
  const defaults: Plan = {
    confirmReadOnly: [{ transaction_read_only: 'on' }],
    migrationsTable: [{ present: true }],
    migrationsApplied: [{ n: 12, last_when: EXPECTED.lastMigrationWhen }],
    qrColumn: [{ present: true }],
    verifiedIndex: [{ present: true }],
    oldConstraint: [{ present: false }],
    credentialsColumns: [{ n: 2 }],
    nullCutoff: [{ n: 0 }],
    verifiedEmail: [{ n: 3 }],
  };
  for (const [key, rows] of Object.entries({ ...defaults, ...plan })) bySql.set(STATEMENTS[key as keyof typeof STATEMENTS], rows!);
  const client: Queryable = {
    async query(sql: string) {
      issued.push(sql);
      return { rows: bySql.get(sql) ?? [] };
    },
  };
  return { client, issued };
}

describe('customer email auth readiness check', () => {
  it('only ever issues read-only statements, inside a transaction it rolls back', async () => {
    const { client, issued } = fake();
    await collectReadiness(client, EXPECTED);
    expect(issued[0]).toBe('BEGIN READ ONLY');
    expect(issued.at(-1)).toBe('ROLLBACK');
    for (const sql of Object.values(STATEMENTS)) {
      expect(sql, sql).toMatch(/^(SELECT|SHOW|BEGIN READ ONLY|ROLLBACK)\b/);
      expect(sql, sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|COMMIT)\b/i);
    }
  });

  it('aborts and still rolls back when the database does not confirm the transaction is read-only', async () => {
    const { client, issued } = fake({ confirmReadOnly: [{ transaction_read_only: 'off' }] });
    await expect(collectReadiness(client, EXPECTED)).rejects.toThrow('READ_ONLY_NOT_CONFIRMED');
    expect(issued).not.toContain(STATEMENTS.nullCutoff); // nothing was counted
    expect(issued.at(-1)).toBe('ROLLBACK');
  });

  it('a fully migrated database with no null cutoffs is READY', async () => {
    const report = await collectReadiness(fake().client, EXPECTED);
    expect(report).toMatchObject({ migrationsApplied: 12, credentialsWithNullLegacyCutoff: 0, credentialsWithVerifiedLoginEmail: 3 });
    expect(problems(report)).toEqual([]);
    expect(isReady(report)).toBe(true);
    expect(formatReport(report)).toContain('RESULT: READY');
  });

  it('any credential without a legacy cutoff makes it NOT READY and says why (the lockout risk)', async () => {
    const report = await collectReadiness(fake({ nullCutoff: [{ n: 2 }] }).client, EXPECTED);
    expect(isReady(report)).toBe(false);
    expect(problems(report)).toEqual([expect.stringContaining('2 credential(s) have no legacy cutoff')]);
  });

  it('a database behind the repository is NOT READY, naming each missing object', async () => {
    const report = await collectReadiness(fake({
      migrationsApplied: [{ n: 11, last_when: 1 }],
      qrColumn: [{ present: false }],
      verifiedIndex: [{ present: false }],
      oldConstraint: [{ present: true }],
    }).client, EXPECTED);
    const text = problems(report).join(' | ');
    expect(text).toMatch(/11 but the repository defines 12/);
    expect(text).toMatch(/does not match the repository journal/);
    expect(text).toMatch(/qr_revocation_epoch is missing \(migration 0078\)/);
    expect(text).toMatch(/customers_phone_verified_unique is missing \(migration 0079\)/);
    expect(text).toMatch(/old global customers_phone_unique constraint is still present/);
  });

  it('never infers: a missing migration history table is reported as unknown and NOT READY', async () => {
    const report = await collectReadiness(fake({ migrationsTable: [{ present: false }] }).client, EXPECTED);
    expect(report.migrationsApplied).toBeNull();
    expect(report.lastAppliedMatchesRepository).toBeNull();
    expect(problems(report)).toContain('migration history table not found');
  });

  it('without the credential columns the counts are n/a, never guessed as zero', async () => {
    const { client, issued } = fake({ credentialsColumns: [{ n: 0 }] });
    const report = await collectReadiness(client, EXPECTED);
    expect(report.credentialsWithNullLegacyCutoff).toBeNull();
    expect(issued).not.toContain(STATEMENTS.nullCutoff);
    expect(isReady(report)).toBe(false);
  });

  it('the printed report holds counts and flags only: no identity, contact, token or connection detail', async () => {
    const report: ReadinessReport = await collectReadiness(fake().client, EXPECTED);
    const text = formatReport(report);
    expect(text).not.toMatch(/@|postgres(ql)?:\/\/|\+\d{6,}|password|secret|token=/i);
    expect(Object.keys(report).sort()).toEqual([
      'credentialsTablePresent', 'credentialsWithNullLegacyCutoff', 'credentialsWithVerifiedLoginEmail',
      'customersQrRevocationEpochColumn', 'lastAppliedMatchesRepository', 'legacyGlobalPhoneConstraintPresent',
      'migrationsApplied', 'phoneVerifiedUniqueIndex', 'repositoryMigrationCount',
    ]);
  });
});
