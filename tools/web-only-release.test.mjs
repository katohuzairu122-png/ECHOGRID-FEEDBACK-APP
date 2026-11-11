import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertReleaseBinding, assertProductionProtection, assertDeploymentContinuity, assertWebOnlyConfiguration } from './web-only-release.mjs';

const sha = 'a'.repeat(40);
const validBinding = { expected: sha, runSha: sha, main: sha, ref: 'refs/heads/main', confirmation: 'DEPLOY_PRODUCTION_WEB_ONLY' };
test('accepts only an exact current-main Web-only release binding', () => { assert.doesNotThrow(() => assertReleaseBinding(validBinding)); });
for (const change of [{ expected: 'short' }, { runSha: 'b'.repeat(40) }, { main: 'b'.repeat(40) }, { ref: 'refs/heads/feature' }, { confirmation: 'DEPLOY_PRODUCTION_RELEASE' }]) {
  test('denies release binding ' + Object.keys(change)[0], () => assert.throws(() => assertReleaseBinding({ ...validBinding, ...change })));
}
const environment = { name: 'production', protection_rules: [{ type: 'required_reviewers', prevent_self_review: true, reviewers: [{ type: 'User' }] }], deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } };
test('accepts configured independent protection', () => assert.doesNotThrow(() => assertProductionProtection(environment)));
test('denies missing reviewers', () => assert.throws(() => assertProductionProtection({ ...environment, protection_rules: [] })));
test('denies self-review', () => assert.throws(() => assertProductionProtection({ ...environment, protection_rules: [{ ...environment.protection_rules[0], prevent_self_review: false }] })));
test('denies unrestricted environment branches', () => assert.throws(() => assertProductionProtection({ ...environment, deployment_branch_policy: null })));
const before = { apiVersions: [{ version_id: 'api-version', percentage: 100 }] };
const after = { ...before, webVersions: [{ version_id: 'web-version', percentage: 100 }] };
test('accepts matching Web version and unchanged API', () => assert.doesNotThrow(() => assertDeploymentContinuity(before, after, 'web-version')));
test('denies an API deployment change', () => assert.throws(() => assertDeploymentContinuity(before, { ...after, apiVersions: [] }, 'web-version')));
test('denies a different or partial Web deployment', () => {
  assert.throws(() => assertDeploymentContinuity(before, after, 'other-version'));
  assert.throws(() => assertDeploymentContinuity(before, { ...after, webVersions: [{ version_id: 'web-version', percentage: 50 }] }, 'web-version'));
});
const config = 'name = "echo-grid-feedback-web"\n[assets]\ndirectory=".open-next/assets"';
const adapter = "import { defineCloudflareConfig } from '@opennextjs/cloudflare';\nexport default defineCloudflareConfig();";
test('permits only the current stateless Web target', () => assert.doesNotThrow(() => assertWebOnlyConfiguration(config, adapter)));
test('rejects API target, remote resource bindings and cache helpers', () => {
  assert.throws(() => assertWebOnlyConfiguration(config.replace('feedback-web', 'feedback-api'), adapter));
  assert.throws(() => assertWebOnlyConfiguration(config + '\n[[r2_buckets]]', adapter));
  assert.throws(() => assertWebOnlyConfiguration(config, adapter.replace('CloudflareConfig()', 'CloudflareConfig({incrementalCache:cache})')));
});
test('manual workflow binds CI, environment, immutable artifact and Web-only deploy', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-web-only.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n {2}(push|pull_request|schedule):/);
  assert.match(workflow, /group: production-release/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci-cd.yml/);
  assert.match(workflow, /needs: \[authorize, verify, package\]/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /sha256sum --check web-worker.sha256/);
  assert.match(workflow, /wrangler deploy --name=echo-grid-feedback-web --env=""/);
  assert.match(workflow, /OPEN_NEXT_DEPLOY: 'true'/);
  assert.doesNotMatch(workflow, /command: deploy|db:migrate|secret put|wrangler deploy.*api|filter @echo-grid-feedback\/api/);
});
