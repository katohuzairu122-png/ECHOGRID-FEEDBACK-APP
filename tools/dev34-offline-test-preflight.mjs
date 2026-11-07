#!/usr/bin/env node
/**
 * DEV-34: read-only, offline local readiness preflight.
 * Never reads secret values, connects to providers, runs migrations or deploys.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function inspectOfflineReadiness(root) {
  const required = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'apps/api/package.json', 'apps/web/package.json',
    'apps/api/wrangler.toml', 'apps/web/wrangler.toml',
    'docs/SETUP.md', 'docs/DEPLOYMENT.md',
    'docs/architecture/builds/SPLIT-08/DEV33_SANDBOX_TEST_READINESS_GATES.md',
  ];
  const checks = required.map((path) => ({ path, present: existsSync(resolve(root, path)) }));
  let packageManager = null;
  try {
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    packageManager = pkg.packageManager ?? null;
  } catch { /* reported by file checks; never reveal file content */ }
  const managerValid = typeof packageManager === 'string' && /^pnpm@11\.[0-9]+\.[0-9]+$/.test(packageManager);
  return Object.freeze({
    status: checks.every((c) => c.present) && managerValid ? 'OFFLINE_PREFLIGHT_PASS' : 'OFFLINE_PREFLIGHT_BLOCKED',
    checks: Object.freeze(checks.map((c) => Object.freeze(c))),
    packageManagerValid: managerValid,
    externalIntegrationVerified: false,
    migrationsApplied: false,
    runtimeReady: false,
    productionAuthorized: false,
  });
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const result = inspectOfflineReadiness(root);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result.status !== 'OFFLINE_PREFLIGHT_PASS') process.exitCode = 1;
}
