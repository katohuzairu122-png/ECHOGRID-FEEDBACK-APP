import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * DEV-56: static checks of STAGING and MIGRATION release paths.
 * Production deployment was already covered by deployment-governance.test.ts.
 * These checks never dispatch workflows or access GitHub environment settings.
 */
const workflows = resolve(__dirname, '../../../../.github/workflows');

function workflow(name: string): string {
  return readFileSync(resolve(workflows, name), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .join('\n');
}

const manual = [
  ['deploy-staging.yml', 'DEPLOY_STAGING'],
  ['migrate-staging.yml', 'MIGRATE_STAGING'],
  ['migrate-production.yml', 'MIGRATE_PRODUCTION'],
] as const;

describe('DEV-56 manual staging/migration workflow trust boundaries', () => {
  it.each(manual)('%s stays manual-only, uses a precise main commit and explicit operator confirmation', (name, phrase) => {
    const source = workflow(name);
    const trigger = source.slice(source.indexOf('\non:\n') + 1, source.indexOf('\npermissions:'));
    expect(trigger).toMatch(/^on:\n {2}workflow_dispatch:\n/);
    expect(trigger).not.toMatch(/^ {2}(push|pull_request|schedule|workflow_run|repository_dispatch):/m);
    expect(source).toMatch(/^permissions:\n {2}contents: read$/m);
    expect(source).toMatch(/^ {2}group: (staging-deployment|staging-database-migration|production-database-migration)$/m);
    expect(source).toContain('cancel-in-progress: false');
    expect(source).toContain('ref: main');
    expect(source).toContain('[[ "$EXPECTED_COMMIT" =~ ^[0-9a-f]{40}$ ]]');
    expect(source).toContain('test "$(git rev-parse HEAD)" = "$EXPECTED_COMMIT"');
    expect(source).toContain(`test "$CONFIRMATION" = "${phrase}"`);
    expect(source).toContain('set -euo pipefail');
  });

  it('staging deploy is restricted to its environment and both deploy targets', () => {
    const stage = workflow('deploy-staging.yml');
    expect(stage).toMatch(/^ {4}environment: staging$/m);
    expect(stage).toContain('command: deploy --env staging');
    expect(stage).toContain('opennextjs-cloudflare deploy --env staging');
    expect(stage).toContain('https://echo-grid-feedback-api-staging.');
    expect(stage).toContain('https://echo-grid-feedback-web-staging.');
    expect(stage).not.toContain('environment: production');
    expect(stage).not.toContain('PRODUCTION_DATABASE_URL');
  });

  it.each([
    ['migrate-staging.yml', 'staging', 'STAGING_DATABASE_URL'],
    ['migrate-production.yml', 'production', 'PRODUCTION_DATABASE_URL'],
  ] as const)('%s uses the isolated environment and verifies the migration chain on either side of apply', (name, environment, secret) => {
    const migration = workflow(name);
    expect(migration).toContain(`environment: ${environment}`);
    expect(migration).toContain(`DATABASE_URL: \x24{{ secrets.${secret} }}`);
    expect(migration).not.toContain(environment === 'staging' ? 'PRODUCTION_DATABASE_URL' : 'STAGING_DATABASE_URL');
    const chain = migration.indexOf('db:check');
    const apply = migration.indexOf('db:migrate');
    const verify = migration.indexOf('db:verify:production');
    expect(chain).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(chain);
    expect(verify).toBeGreaterThan(apply);
    expect(migration).not.toContain('wrangler-action');
    expect(migration).not.toContain('opennextjs-cloudflare deploy');
  });

  it('CI remains verification-only and cannot automatically trigger the three manual paths', () => {
    const ci = workflow('ci-cd.yml');
    expect(ci).toContain('pull_request:');
    expect(ci).toContain('workflow_call:');
    expect(ci).not.toContain('workflow_dispatch:');
    expect(ci).not.toContain('secrets.');
    for (const marker of ['deploy-staging.yml', 'migrate-staging.yml', 'migrate-production.yml']) {
      expect(ci).not.toContain(`uses: ./.github/workflows/${marker}`);
    }
  });
});
