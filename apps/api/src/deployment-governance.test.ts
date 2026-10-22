import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * HETA-01-F1 B3: STATIC properties of the GitHub Actions workflows that govern production release. These tests read the
 * workflow files; they cannot prove GitHub's `production` environment has required reviewers (an owner-controlled
 * repository setting) and they never deploy anything. Live enforcement is PENDING OWNER ACTION (docs/PRODUCTION-RELEASE.md).
 */
const dir = resolve(__dirname, '../../../.github/workflows');
const files = readdirSync(dir).filter(f => f.endsWith('.yml'));
const read = (n: string) => readFileSync(resolve(dir, n), 'utf8');
const strip = (t: string) => t.split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
const code = (n: string) => strip(read(n));
/** Text of one top-level job (from `  name:` to the next job or end of file). */
const job = (n: string, name: string) => {
  const t = code(n);
  const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\n|(?![\\s\\S]))`, 'm').exec(t);
  if (!m) throw new Error(`job ${name} not found in ${n}`);
  return m[1]!;
};
const jobNames = (n: string) => [...code(n).split(/^jobs:\n/m)[1]!.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map(m => m[1]!);
const onBlock = (n: string) => /^on:\n((?:[ ].*\n|\n)*)/m.exec(code(n))![1]!;

const RELEASE = 'deploy-production.yml';
const DEPLOYERS = [RELEASE, 'deploy-staging.yml'];

describe('B3 production deployment governance (static workflow checks)', () => {
  it('1-2. pull-request and main-push CI contains no deploy step, no Cloudflare credential and no secret reference', () => {
    const ci = code('ci-cd.yml');
    expect(onBlock('ci-cd.yml')).toMatch(/push:\s*\n\s+branches: \[main\]/);
    expect(onBlock('ci-cd.yml')).toMatch(/pull_request:/);
    expect(jobNames('ci-cd.yml')).toEqual(['verify']);
    for (const forbidden of [/wrangler-action/, /wrangler deploy/, /pnpm run deploy/, /opennextjs-cloudflare deploy/, /secrets\./, /CLOUDFLARE_API_TOKEN/, /CLOUDFLARE_ACCOUNT_ID/, /environment:/, /migrate-production/, /PRODUCTION_DATABASE_URL/]) expect(ci, String(forbidden)).not.toMatch(forbidden);
  });

  it('only the two manual deploy workflows contain any deployment command', () => {
    for (const f of files.filter(x => !DEPLOYERS.includes(x))) {
      expect(code(f), f).not.toMatch(/wrangler-action|wrangler deploy|pnpm run deploy|opennextjs-cloudflare deploy|secrets\.CLOUDFLARE/);
    }
  });

  it('no workflow can be triggered by pull_request_target, workflow_run or repository_dispatch (no bypass path)', () => {
    for (const f of files) for (const t of ['pull_request_target', 'workflow_run', 'repository_dispatch']) expect(code(f), `${f} ${t}`).not.toContain(t);
  });

  it('every workflow declares least-privilege read-only repository permissions at the top level', () => {
    for (const f of files) {
      expect(code(f), f).toMatch(/^permissions:\n {2}contents: read\n/m);
      expect(code(f), f).not.toMatch(/contents: write|id-token: write|actions: write|pull-requests: write/);
    }
  });

  it('3-4. the release is manual, bound to an exact 40-hex SHA that equals this run and the CURRENT tip of main, from the main ref only', () => {
    expect(onBlock(RELEASE)).toMatch(/^ {2}workflow_dispatch:/m);
    expect(onBlock(RELEASE)).not.toMatch(/push:|pull_request|schedule:/);
    const a = job(RELEASE, 'authorize');
    expect(a).toContain('ref: main');
    expect(a).toContain('fetch-depth: 0');
    expect(a).toContain('^[0-9a-f]{40}$');
    expect(a).toContain('"$DISPATCH_REF" = "refs/heads/main"');
    expect(a).toContain('"$RUN_SHA" = "$EXPECTED_COMMIT"');
    expect(a).toContain('"$(git rev-parse HEAD)"');
    expect(a).toMatch(/TIP.*=.*EXPECTED_COMMIT/);
    expect(a).toContain('commit=$EXPECTED_COMMIT');
    expect(a).not.toContain('secrets.');
  });

  it('6. a missing or wrong confirmation phrase fails closed before anything else runs', () => {
    const a = job(RELEASE, 'authorize');
    expect(a).toContain('"$CONFIRMATION" = "DEPLOY_PRODUCTION_RELEASE"');
    expect(a).toMatch(/\|\| \{ echo [^}]*exit 1; \}/);
    expect(a).toContain('set -euo pipefail');
  });

  it('5. both production deploy jobs run in the protected `production` environment (the reviewer gate); the typed phrase is not the approval', () => {
    for (const j of ['deploy-api', 'deploy-web']) expect(job(RELEASE, j), j).toMatch(/^ {4}environment: production$/m);
    expect(read(RELEASE)).toMatch(/typed phrase is a guard against typos, NOT approval/);
    // the Cloudflare credentials are referenced only inside those protected jobs
    const credentialJobs = jobNames(RELEASE).filter(j => /secrets\.CLOUDFLARE/.test(job(RELEASE, j)));
    expect(credentialJobs.sort()).toEqual(['deploy-api', 'deploy-web']);
  });

  it('7-8. deployment requires the full CI gate in the same run; failed, cancelled or skipped validation can never count as success', () => {
    expect(job(RELEASE, 'verify')).toContain('uses: ./.github/workflows/ci-cd.yml');
    expect(code('ci-cd.yml')).toMatch(/^ {2}workflow_call:/m);
    expect(job(RELEASE, 'deploy-api')).toMatch(/needs: \[authorize, verify\]/);
    expect(job(RELEASE, 'deploy-api')).toMatch(/if: needs\.verify\.result == 'success'/);
    expect(job(RELEASE, 'deploy-web')).toMatch(/needs: \[authorize, verify, deploy-api\]/);
    expect(job(RELEASE, 'deploy-web')).toMatch(/if: needs\.deploy-api\.result == 'success'/);
    // Job-level conditions (4-space indent) may never use always()/!cancelled(); step-level `if: always()` is only for provenance upload.
    for (const j of jobNames(RELEASE)) {
      const b = job(RELEASE, j);
      expect(b, j).not.toMatch(/continue-on-error/);
      for (const l of b.split('\n').filter(x => /^ {4}if:/.test(x))) expect(l, `${j} ${l}`).not.toMatch(/always\(\)|!cancelled\(\)|failure\(\)/);
    }
  });

  it('9. API and web check out and re-verify the SAME authorized commit, never a branch name', () => {
    for (const j of ['deploy-api', 'deploy-web']) {
      const b = job(RELEASE, j);
      expect(b, j).toContain('ref: ${{ needs.authorize.outputs.commit }}');
      expect(b, j).toContain('test "$(git rev-parse HEAD)" = "$AUTHORIZED"');
      expect(b, j).not.toMatch(/ref: main/);
    }
    expect(job(RELEASE, 'deploy-api')).toContain('command: deploy\n');
    expect(job(RELEASE, 'deploy-api')).not.toContain('--env');
    expect(job(RELEASE, 'deploy-web')).toContain('pnpm run deploy');
  });

  it('API/web provenance is recorded per Worker with commit, outcome, run and actor', () => {
    for (const [j, w] of [['deploy-api', 'api'], ['deploy-web', 'web']] as const) {
      const b = job(RELEASE, j);
      expect(b).toContain(`provenance/${w}.json`);
      expect(b).toContain(`release-provenance-${w}`);
      for (const k of ['commit', 'outcome', 'runId', 'actor', 'recordedAt']) expect(b).toContain(`"${k}"`);
    }
  });

  it('14. post-deployment runtime checks exist only in the release workflow and only after a successful web deployment', () => {
    const ci = jobNames('ci-cd.yml');
    const post = ['block-2e-runtime', 'block-2f-release', 'block-2g-commercial', 'block-2h-launch-readiness'];
    for (const p of post) {
      expect(ci).not.toContain(p);
      expect(jobNames(RELEASE)).toContain(p);
    }
    expect(job(RELEASE, 'block-2e-runtime')).toMatch(/needs: \[authorize, deploy-web\]\n\s+if: needs\.deploy-web\.result == 'success'/);
    expect(job(RELEASE, 'block-2f-release')).toMatch(/needs: \[authorize, block-2e-runtime\]/);
    expect(job(RELEASE, 'block-2g-commercial')).toMatch(/needs: \[authorize, block-2f-release\]/);
    expect(job(RELEASE, 'block-2h-launch-readiness')).toMatch(/needs: \[authorize, block-2g-commercial\]/);
    expect(job(RELEASE, 'block-2h-launch-readiness')).toContain('BLOCK18_GIT_COMMIT: ${{ needs.authorize.outputs.commit }}');
    for (const p of post) expect(job(RELEASE, p), p).not.toContain('secrets.');
  });

  it('11. staging stays a separate manual path in its own environment with its own target', () => {
    const s = code('deploy-staging.yml');
    expect(onBlock('deploy-staging.yml')).toMatch(/^ {2}workflow_dispatch:/m);
    expect(onBlock('deploy-staging.yml')).not.toMatch(/push:|pull_request|schedule:/);
    expect(s).toMatch(/environment: staging/);
    expect(s).toContain('--env staging');
    expect(s).toContain('"DEPLOY_STAGING"');
    expect(code(RELEASE)).not.toContain('--env staging');
  });

  it('12. both certification workflows remain manual-only', () => {
    for (const f of ['heta-f1-certification.yml', 'split07-neon-certification.yml']) {
      expect(onBlock(f), f).toMatch(/^ {2}workflow_dispatch:/m);
      expect(onBlock(f), f).not.toMatch(/push:|pull_request|schedule:/);
    }
  });

  it('13. production migration stays a separate authorization and is never coupled to a release', () => {
    const m = code('migrate-production.yml');
    expect(onBlock('migrate-production.yml')).toMatch(/^ {2}workflow_dispatch:/m);
    expect(m).toMatch(/environment: production/);
    expect(m).toContain('"MIGRATE_PRODUCTION"');
    // ci-cd.yml migrates only its own EPHEMERAL service-container database; the release workflow never migrates anything.
    for (const f of ['ci-cd.yml', RELEASE]) expect(code(f), f).not.toMatch(/PRODUCTION_DATABASE_URL|migrate-production/);
    expect(code(RELEASE)).not.toMatch(/db:migrate|drizzle-kit/);
  });

  it('release documentation exists and states live enforcement is an owner action', () => {
    const doc = readFileSync(resolve(dir, '../../docs/PRODUCTION-RELEASE.md'), 'utf8');
    expect(doc).toMatch(/PENDING OWNER ACTION/);
    expect(doc).toMatch(/not atomic/i);
    expect(doc).toMatch(/Required reviewers/i);
  });
});
