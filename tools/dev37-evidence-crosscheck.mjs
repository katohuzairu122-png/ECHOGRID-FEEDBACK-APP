import { DEV36_PHASES, planDev36Sandbox } from './dev36-sandbox-test-plan.mjs';

/**
 * Offline cross-check of claimed test statuses against recorded nonsecret evidence.
 * Evidence is not independently authenticated; operator review is still required.
 */
export function validateDev37Evidence({ baselineSha, statuses, evidence }) {
  if (typeof baselineSha !== 'string' || !/^[a-f0-9]{40}$/.test(baselineSha) ||
      !statuses || typeof statuses !== 'object' || Array.isArray(statuses) ||
      !Array.isArray(evidence) || evidence.length > 100)
    throw new Error('DEV37_INPUT_INVALID');
  const ids = new Set(DEV36_PHASES.map(p=>p.id));
  const byPhase = new Map();
  for (const item of evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join('|') !== 'baselineSha|phase|reference|result' ||
        !ids.has(item.phase) || item.baselineSha !== baselineSha ||
        item.result !== 'PASS' || typeof item.reference !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/#-]{0,255}$/.test(item.reference) ||
        byPhase.has(item.phase))
      throw new Error('DEV37_EVIDENCE_INVALID');
    byPhase.set(item.phase,item);
  }
  const plan = planDev36Sandbox(DEV36_PHASES,statuses);
  const accepted = [];
  for (const phase of plan.phases) {
    if (phase.observedStatus !== 'PASS') continue;
    if (!byPhase.has(phase.id) ||
        DEV36_PHASES.find(p=>p.id===phase.id).dependencies.some(dep=>statuses[dep]!=='PASS'))
      throw new Error('DEV37_PASS_UNSUPPORTED');
    accepted.push(phase.id);
  }
  if ([...byPhase.keys()].some(id=>statuses[id]!=='PASS'))
    throw new Error('DEV37_ORPHAN_EVIDENCE');
  return Object.freeze({
    verdict:'OFFLINE_CROSSCHECK_PASS',
    evidencePhases:Object.freeze(accepted),
    independentlyVerified:false,
    integrationExecuted:false,
    migrationsExecuted:false,
    deploymentAuthorized:false,
    financialAuthorization:'NOT_GRANTED',
  });
}
