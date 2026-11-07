import { DEV36_PHASES, planDev36Sandbox } from './dev36-sandbox-test-plan.mjs';
import { validateDev37Evidence } from './dev37-evidence-crosscheck.mjs';

/**
 * DEV-38: offline aggregation only. No provider, database, migration or deployment calls.
 */
export function assessDev38Readiness({ baselineSha, statuses, evidence, preflight, manifest }) {
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight) ||
      !manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    throw new Error('DEV38_INPUT_INVALID');
  if (preflight.status !== 'OFFLINE_PREFLIGHT_PASS' ||
      manifest.verdict !== 'SANDBOX_EVIDENCE_COMPLETE') {
    return Object.freeze({verdict:'BLOCKED',reason:'UPSTREAM_GATE_NOT_PASS',
      independentVerification:false,executionAuthorized:false,
      migrationAuthorized:false,deploymentAuthorized:false,financialAuthorization:'NOT_GRANTED'});
  }
  const plan = planDev36Sandbox(DEV36_PHASES,statuses);
  const crosscheck = validateDev37Evidence({baselineSha,statuses,evidence});
  const required = DEV36_PHASES.filter(p=>p.id!=='stripe-test-credentials' && p.id!=='stripe-sandbox');
  const complete = required.every(p=>statuses[p.id]==='PASS');
  return Object.freeze({
    verdict:complete ? 'OFFLINE_RECORD_CONSISTENT' : 'BLOCKED',
    reason:complete ? 'REQUIRES_INDEPENDENT_REVIEW' : 'INCOMPLETE_REQUIRED_PHASES',
    checkedPhases:crosscheck.evidencePhases.length,
    phaseCount:plan.phases.length,
    independentVerification:false,
    executionAuthorized:false,migrationAuthorized:false,
    deploymentAuthorized:false,financialAuthorization:'NOT_GRANTED',
  });
}
