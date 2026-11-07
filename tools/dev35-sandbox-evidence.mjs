import { readFileSync } from 'node:fs';

const REQUIRED = Object.freeze([
  'baselineSha','environment','isolationVerified','migrationAuthorization',
  'databaseMigrationStatus','apiHealth','webHealth','tenantIsolation',
  'qrFeedback','loyaltyAward','loyaltyRedemption','billingSandbox',
  'evidenceReferences',
]);
const STATES = Object.freeze(['NOT_RUN','PASS','FAIL','BLOCKED','NOT_APPLICABLE']);

export function classifyDev35Manifest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).sort().join('|') !== [...REQUIRED].sort().join('|'))
    throw new Error('DEV35_MANIFEST_SCHEMA_INVALID');
  if (typeof input.baselineSha !== 'string' || !/^[a-f0-9]{40}$/.test(input.baselineSha) ||
      input.environment !== 'isolated-staging' ||
      input.isolationVerified !== true ||
      !['NOT_REQUESTED','EXPLICITLY_APPROVED'].includes(input.migrationAuthorization) ||
      !Array.isArray(input.evidenceReferences) ||
      input.evidenceReferences.length > 100 ||
      !input.evidenceReferences.every(x => typeof x === 'string' && x.length > 0 && x.length <= 256 && !/\s/.test(x)))
    throw new Error('DEV35_MANIFEST_INVALID');
  const fields = REQUIRED.filter(x => !['baselineSha','environment','isolationVerified','migrationAuthorization','evidenceReferences'].includes(x));
  if (!fields.every(x => STATES.includes(input[x]))) throw new Error('DEV35_STATUS_INVALID');
  if (input.databaseMigrationStatus === 'PASS' && input.migrationAuthorization !== 'EXPLICITLY_APPROVED')
    throw new Error('DEV35_MIGRATION_AUTHORIZATION_MISSING');
  const requiredPass = ['databaseMigrationStatus','apiHealth','webHealth','tenantIsolation','qrFeedback','loyaltyAward','loyaltyRedemption'];
  const blocked = requiredPass.some(x => input[x] !== 'PASS') || input.evidenceReferences.length === 0;
  return Object.freeze({
    verdict: blocked ? 'NOT_READY' : 'SANDBOX_EVIDENCE_COMPLETE',
    billingSandbox: input.billingSandbox,
    productionAuthorized: false,
    financialAuthorization: 'NOT_GRANTED',
    deploymentAuthorized: false,
  });
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('DEV35_INPUT_PATH_REQUIRED');
    const result = classifyDev35Manifest(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.verdict !== 'SANDBOX_EVIDENCE_COMPLETE') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(String(error?.message ?? 'DEV35_ERROR') + '\n');
    process.exitCode = 1;
  }
}
