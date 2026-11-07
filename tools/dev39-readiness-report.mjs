import { assessDev38Readiness } from './dev38-readiness-aggregation.mjs';

/**
 * DEV-39: deterministic, non-authoritative offline report generator.
 * Never includes secrets, raw evidence, or live system claims.
 */
export function generateDev39ReadinessReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.baselineSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.baselineSha))
    throw new Error('DEV39_INPUT_INVALID');
  const assessment=assessDev38Readiness(input);
  return Object.freeze({
    schemaVersion:'dev39.v1',
    baselineSha:input.baselineSha,
    verdict:assessment.verdict,
    reason:assessment.reason,
    checkedPhases:assessment.checkedPhases ?? 0,
    phaseCount:assessment.phaseCount ?? 0,
    evidenceReferenceCount:Array.isArray(input.evidence) ? input.evidence.length : 0,
    source:'CALLER_SUPPLIED_OFFLINE_RECORD',
    independentlyVerified:false,
    stagingExecutionAuthorized:false,
    migrationAuthorized:false,
    deploymentAuthorized:false,
    financialAuthorization:'NOT_GRANTED',
  });
}

export function formatDev39ReadinessMarkdown(report) {
  if (!report || report.schemaVersion!=='dev39.v1' ||
      typeof report.baselineSha!=='string' || !/^[a-f0-9]{40}$/.test(report.baselineSha) ||
      !['BLOCKED','OFFLINE_RECORD_CONSISTENT'].includes(report.verdict))
    throw new Error('DEV39_REPORT_INVALID');
  return [
    '# DEV-39 — Offline Integration Readiness Report',
    '',
    '- Schema: dev39.v1',
    '- Baseline SHA: '+report.baselineSha,
    '- Verdict: '+report.verdict,
    '- Reason: '+report.reason,
    '- Checked phases: '+report.checkedPhases+'/'+report.phaseCount,
    '- Evidence references supplied: '+report.evidenceReferenceCount,
    '- Evidence independently verified: NO',
    '- Staging execution authorized: NO',
    '- Migrations authorized: NO',
    '- Deployment authorized: NO',
    '- Financial authorization: NOT_GRANTED',
    '',
    'This report only evaluates caller-supplied offline records. Independent evidence review and explicit owner approval are mandatory before any integration or migration.',
    '',
  ].join('\n');
}
