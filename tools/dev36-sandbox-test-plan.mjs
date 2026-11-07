/**
 * DEV-36: pure, offline, deterministic ordering of future sandbox test cases.
 * This does not execute tests, access external services, or authorize migrations.
 */
export const DEV36_PHASES = Object.freeze([
  Object.freeze({id:'baseline',dependencies:Object.freeze([])}),
  Object.freeze({id:'isolation',dependencies:Object.freeze(['baseline'])}),
  Object.freeze({id:'configuration',dependencies:Object.freeze(['isolation'])}),
  Object.freeze({id:'migration-approval',dependencies:Object.freeze(['configuration'])}),
  Object.freeze({id:'staging-schema',dependencies:Object.freeze(['migration-approval'])}),
  Object.freeze({id:'api-health',dependencies:Object.freeze(['staging-schema'])}),
  Object.freeze({id:'web-health',dependencies:Object.freeze(['api-health'])}),
  Object.freeze({id:'tenant-isolation',dependencies:Object.freeze(['web-health'])}),
  Object.freeze({id:'qr-feedback',dependencies:Object.freeze(['tenant-isolation'])}),
  Object.freeze({id:'loyalty-award',dependencies:Object.freeze(['qr-feedback'])}),
  Object.freeze({id:'loyalty-redemption',dependencies:Object.freeze(['loyalty-award'])}),
  Object.freeze({id:'stripe-test-credentials',dependencies:Object.freeze(['tenant-isolation'])}),
  Object.freeze({id:'stripe-sandbox',dependencies:Object.freeze(['stripe-test-credentials'])}),
]);

const STATES = Object.freeze(['NOT_RUN','PASS','FAIL','BLOCKED']);
export function planDev36Sandbox(phases, statuses) {
  if (!Array.isArray(phases) || !phases.length || phases.length > 100 ||
      !statuses || typeof statuses !== 'object' || Array.isArray(statuses))
    throw new Error('DEV36_INPUT_INVALID');
  const ids = new Set();
  for (const phase of phases) {
    if (!phase || typeof phase.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(phase.id) ||
        !Array.isArray(phase.dependencies) || ids.has(phase.id))
      throw new Error('DEV36_PHASE_INVALID');
    ids.add(phase.id);
  }
  const byId = new Map(phases.map(p=>[p.id,p]));
  for (const phase of phases) {
    if (new Set(phase.dependencies).size !== phase.dependencies.length ||
        phase.dependencies.some(dep=>!byId.has(dep) || dep===phase.id))
      throw new Error('DEV36_DEPENDENCY_INVALID');
  }
  if (Object.keys(statuses).some(id=>!ids.has(id) || !STATES.includes(statuses[id])))
    throw new Error('DEV36_STATUS_INVALID');
  const visiting = new Set(),visited = new Set(),order = [];
  const visit = id => {
    if (visiting.has(id)) throw new Error('DEV36_CYCLE_INVALID');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).dependencies) visit(dep);
    visiting.delete(id);visited.add(id);order.push(id);
  };
  for (const phase of phases) visit(phase.id);
  const entries = order.map(id=>{
    const dependencies = byId.get(id).dependencies;
    const unmet = dependencies.filter(dep=>statuses[dep]!=='PASS');
    return Object.freeze({
      id, observedStatus:statuses[id]??'NOT_RUN',
      prerequisitesSatisfied:unmet.length===0,
      unmetDependencies:Object.freeze(unmet),
      eligibleForFutureManualTest:unmet.length===0 && statuses[id]!=='PASS',
    });
  });
  return Object.freeze({
    phases:Object.freeze(entries),
    integrationExecuted:false,migrationsExecuted:false,
    deploymentAuthorized:false,financialAuthorization:'NOT_GRANTED',
  });
}
