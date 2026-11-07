import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { inspectOfflineReadiness } from './dev34-offline-test-preflight.mjs';

test('DEV-34 fails closed when resources and metadata are absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'eg-dev34-'));
  try {
    const result = inspectOfflineReadiness(root);
    assert.equal(result.status, 'OFFLINE_PREFLIGHT_BLOCKED');
    assert.equal(result.externalIntegrationVerified, false);
    assert.equal(result.migrationsApplied, false);
    assert.equal(result.runtimeReady, false);
    assert.equal(result.productionAuthorized, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('DEV-34 reports static readiness without implying integration', () => {
  const root = mkdtempSync(join(tmpdir(), 'eg-dev34-'));
  try {
    const required = [
      'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'apps/api/package.json',
      'apps/web/package.json', 'apps/api/wrangler.toml',
      'apps/web/wrangler.toml', 'docs/SETUP.md', 'docs/DEPLOYMENT.md',
      'docs/architecture/builds/SPLIT-08/DEV33_SANDBOX_TEST_READINESS_GATES.md',
    ];
    for (const path of required) {
      const full = join(root, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '');
    }
    writeFileSync(join(root, 'package.json'), '{"packageManager":"pnpm@11.9.0"}');
    const result = inspectOfflineReadiness(root);
    assert.equal(result.status, 'OFFLINE_PREFLIGHT_PASS');
    assert.equal(result.checks.length, 10);
    assert.equal(result.externalIntegrationVerified, false);
    assert.equal(result.migrationsApplied, false);
    assert.equal(result.runtimeReady, false);
    assert.equal(result.productionAuthorized, false);
    writeFileSync(join(root, 'package.json'), '{"packageManager":"npm@10.0.0"}');
    assert.equal(inspectOfflineReadiness(root).status, 'OFFLINE_PREFLIGHT_BLOCKED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
