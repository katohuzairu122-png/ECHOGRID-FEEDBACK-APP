import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assessStagingMigrationPreflight, type StagingPreflightInput } from './staging-migration-preflight';

const journal = JSON.parse(readFileSync(resolve(__dirname, '../../drizzle/meta/_journal.json'), 'utf8')).entries as Array<{tag: string; when: number}>;
const requiredInertTriggers = [
  'partner_credit_lots_inert_guard',
  'partner_credit_ledger_insert_disabled',
  'partner_credit_reservations_inert_guard',
  'pc_multiunit_allocation_inert_guard',
  'pc_multiunit_movement_inert_guard',
];
const input: StagingPreflightInput = {
  expectedJournal: journal,
  appliedCreatedAt: journal.slice(0, 45).map(e => String(e.when)),
  pgMajor: 18,
  publicTables: 69,
  rlsEnabledTables: 0,
  requiredInertTriggers,
  observedEnabledTriggers: [...requiredInertTriggers],
  missingRequiredRoles: [
    'settlement_recorder', 'settlement_authority_reader',
    'stripe_read_auth_lifecycle', 'signed_evidence_auditor',
  ],
  backupRestoreDrillVerified: false,
  stagingEnvironmentProtectionVerified: false,
};

describe('Gate 2 non-authorizing staging preflight', () => {
  it('reproduces independently observed staging drift without SQL writes', () => {
    const r = assessStagingMigrationPreflight(input);
    expect(r).toMatchObject({
      status: 'BLOCKED', expectedCount: 70, appliedCount: 45,
      stagingCertified: false, migrationAuthorized: false,
      deploymentAuthorized: false, onboardingAuthorized: false,
      financialAuthorization: 'NOT_GRANTED',
    });
    expect(r.pendingTags).toHaveLength(25);
    expect(r.pendingTags[0]).toBe('0045_heta01_f1_stripe_evidence');
    expect(r.pendingTags.at(-1)).toBe('0069_platform_customer_sanctions');
    for (const reason of [
      'MIGRATIONS_PENDING', 'NEW_SECURITY_MIGRATIONS_PENDING',
      'DATABASE_VERSION_NOT_CERTIFIED', 'ROLE_PROTECTION_UNVERIFIED',
      'RLS_REVIEW_REQUIRED', 'BACKUP_RESTORE_UNVERIFIED',
      'ENVIRONMENT_PROTECTION_UNVERIFIED',
    ]) expect(r.reasons).toContain(reason);
    expect(r.reasons).not.toContain('MIGRATION_CHAIN_MISMATCH');
  });

  it('detects a corrupted applied migration order and never suggests what to apply', () => {
    const swapped = [...input.appliedCreatedAt];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    const r = assessStagingMigrationPreflight({ ...input, appliedCreatedAt: swapped });
    expect(r.reasons).toContain('MIGRATION_CHAIN_MISMATCH');
    expect(r.pendingTags).toEqual([]);
    expect(r.migrationAuthorized).toBe(false);
  });

  it('fails closed if an inert financial guard is absent', () => {
    const r = assessStagingMigrationPreflight({
      ...input, observedEnabledTriggers: requiredInertTriggers.slice(1),
    });
    expect(r.reasons).toContain('INERT_TRIGGERS_MISSING');
    expect(r.financialAuthorization).toBe('NOT_GRANTED');
  });

  it('does not certify release even with all self-reported checks marked green', () => {
    const r = assessStagingMigrationPreflight({
      ...input,
      appliedCreatedAt: journal.map(e => e.when), pgMajor: 16,
      rlsEnabledTables: 12, missingRequiredRoles: [],
      backupRestoreDrillVerified: true,
      stagingEnvironmentProtectionVerified: true,
      claimedReleaseAuthorization: true,
    });
    expect(r.status).toBe('BLOCKED');
    expect(r.reasons).toEqual([]);
    expect(r.stagingCertified).toBe(false);
    expect(r.deploymentAuthorized).toBe(false);
    expect(r.financialAuthorization).toBe('NOT_GRANTED');
  });

  it.each([null, [], {}, { ...input, expectedJournal: [] },
    { ...input, appliedCreatedAt: ['abc'] },
    { ...input, rlsEnabledTables: Number.NaN },
    { ...input, requiredInertTriggers: null },
  ])('rejects malformed evidence %#', bad => {
    expect(() => assessStagingMigrationPreflight(bad)).toThrow('GATE2_EVIDENCE_INVALID');
  });
});
