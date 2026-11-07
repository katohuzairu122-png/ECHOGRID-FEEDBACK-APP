import { describe, expect, it } from 'vitest';
import { assessDev58ReleaseEvidence, formatDev58ReleaseEvidence } from './offline-release-evidence';

const sha = 'a'.repeat(40);
const good = { baselineSha: sha, ci: { commitSha: sha, runId: 12345, status: 'completed', conclusion: 'success' } };

describe('DEV-58 offline release evidence classification and non-authorization', () => {
  it('recognizes internally consistent caller-supplied CI metadata without authorizing anything', () => {
    const result = assessDev58ReleaseEvidence(good);
    expect(result.status).toBe('OFFLINE_CI_RECORD_CONSISTENT');
    expect(result.reason).toBe('REQUIRES_INDEPENDENT_REVIEW');
    expect(result.source).toBe('CALLER_SUPPLIED_OFFLINE_CI_METADATA');
    expect(result.independentlyVerified).toBe(false);
    expect(result.stagingRuntimeVerified).toBe(false);
    expect(result.productionRuntimeVerified).toBe(false);
    expect(result.mergeAuthorized).toBe(false);
    expect(result.migrationAuthorized).toBe(false);
    expect(result.deploymentAuthorized).toBe(false);
    expect(result.financialAuthorization).toBe('NOT_GRANTED');
    expect(result.outstandingGates).toContain('EXPLICIT_PRODUCTION_RELEASE_AUTHORIZATION');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outstandingGates)).toBe(true);
  });

  it.each([
    [{ baselineSha: sha }, 'CI_RECORD_MISSING'],
    [{ ...good, ci: { ...good.ci, commitSha: 'b'.repeat(40) } }, 'CI_COMMIT_MISMATCH'],
    [{ ...good, ci: { ...good.ci, status: 'in_progress', conclusion: null } }, 'CI_RUN_INCOMPLETE'],
    [{ ...good, ci: { ...good.ci, status: 'queued', conclusion: null } }, 'CI_RUN_INCOMPLETE'],
    [{ ...good, ci: { ...good.ci, conclusion: 'failure' } }, 'CI_RUN_NOT_SUCCESSFUL'],
    [{ ...good, ci: { ...good.ci, conclusion: 'cancelled' } }, 'CI_RUN_NOT_SUCCESSFUL'],
    [{ ...good, ci: { ...good.ci, conclusion: 'skipped' } }, 'CI_RUN_NOT_SUCCESSFUL'],
    [{ ...good, ci: { ...good.ci, runId: 0 } }, 'CI_RECORD_INVALID'],
    [{ ...good, ci: { ...good.ci, runId: Number.POSITIVE_INFINITY } }, 'CI_RECORD_INVALID'],
    [{ ...good, ci: { ...good.ci, status: 'nonsense' } }, 'CI_RECORD_INVALID'],
    [{ ...good, ci: { ...good.ci, conclusion: 'nonsense' } }, 'CI_RECORD_INVALID'],
  ])('fails closed for absent, mismatched, unverified or failed evidence %#', (input, reason) => {
    const result = assessDev58ReleaseEvidence(input);
    expect(result.status).toBe('BLOCKED');
    expect(result.reason).toBe(reason);
    expect(result.deploymentAuthorized).toBe(false);
    expect(result.mergeAuthorized).toBe(false);
  });

  it.each([null, undefined, {}, { baselineSha: 'not-a-sha' }, { baselineSha: 'A'.repeat(40) }])(
    'rejects invalid baseline %#', input => {
      expect(() => assessDev58ReleaseEvidence(input)).toThrow('DEV58_BASELINE_SHA_INVALID');
    },
  );

  it('cannot be tricked into granting authority by caller fields or hidden secrets', () => {
    const injected = {
      ...good,
      approved: true,
      independentlyVerified: true,
      stagingRuntimeVerified: true,
      deploymentAuthorized: true,
      migrationAuthorized: true,
      financialAuthorization: 'GRANTED',
      ci: { ...good.ci, rawLog: 'Bearer private-token', url: 'https://secret.example/private' },
    };
    const result = assessDev58ReleaseEvidence(injected);
    const formatted = formatDev58ReleaseEvidence(result);
    expect(result).toEqual(assessDev58ReleaseEvidence(injected));
    expect(formatted).toContain('Deployment authorized: NO');
    expect(formatted).toContain('Merge authorized: NO');
    expect(formatted).toContain('Financial authorization: NOT_GRANTED');
    expect(formatted).not.toContain('private-token');
    expect(formatted).not.toContain('secret.example');
    expect(formatted).not.toContain('rawLog');
  });

  it('never claims independent verification even for a success-shaped record', () => {
    const report = formatDev58ReleaseEvidence(assessDev58ReleaseEvidence(good));
    expect(report).toContain('Independently verified: NO');
    expect(report).toContain('Staging runtime verified: NO');
    expect(report).toContain('Production runtime verified: NO');
    expect(report).toContain('caller-supplied CI success record is not proof');
  });
});
