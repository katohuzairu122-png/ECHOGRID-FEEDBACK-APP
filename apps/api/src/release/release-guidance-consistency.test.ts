import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * DEV-57: guard against operationally unsafe guidance drift. Static text
 * cannot prove any Cloudflare/GitHub/Neon deployment or approval exists.
 */
const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8').replace(/\r\n/g, '\n');

function cronCount(section: string): number {
  const match = /^crons = \[([\s\S]*?)^\]/m.exec(section);
  if (!match) throw new Error('RELEASE_CRON_SCHEDULE_NOT_FOUND');
  return [...match[1]!.matchAll(/^\s*"[^"]+"/gm)].length;
}

describe('DEV-57 static release documentation consistency', () => {
  it('staging and production cron checklist counts match the repository configuration', () => {
    const config = read('apps/api/wrangler.toml');
    const production = config.split(/\n\[triggers\]\n/)[1]?.split(/\n\[observability\]/)[0];
    const staging = config.split(/\n\[env\.staging\.triggers\]\n/)[1]?.split(/\n\[env\.staging\.observability\]/)[0];
    expect(production).toBeDefined();
    expect(staging).toBeDefined();
    expect(cronCount(production!)).toBe(4);
    expect(cronCount(staging!)).toBe(1);
    expect(read('docs/PRODUCTION-CHECKLIST.md')).toContain('all four cron schedules');
    expect(read('docs/DEPLOYMENT.md')).toContain('production currently declares four schedules, staging one');
  });

  it('does not confuse repository files with actual deployed runtime state', () => {
    const runbook = read('docs/DEPLOYMENT.md');
    expect(runbook).toContain('**Release evidence status:**');
    expect(runbook).toContain('production runtime state as **UNVERIFIED**');
    expect(runbook).not.toContain('nothing in this project has been\ndeployed anywhere');
    expect(runbook).not.toContain('no migrations have been\ngenerated');
    expect(runbook).not.toContain('node_modules` doesn\'t exist');
  });

  it('documents that owner environment settings and secrets cannot be verified from git', () => {
    const runbook = read('docs/DEPLOYMENT.md');
    const release = read('docs/PRODUCTION-RELEASE.md');
    expect(runbook).toContain('**Owner-controlled credential and approval gate (UNVERIFIED):**');
    expect(runbook).toContain('Do not dispatch a staging or production workflow');
    expect(release).toContain('Effective production protection is **UNVERIFIED**');
    expect(release).toContain('PENDING OWNER ACTION');
  });

  it('does not promote PR CI or offline evidence to a live launch authorization', () => {
    const launch = read('docs/LAUNCH-READINESS.md');
    expect(launch).toContain('Passing\npull-request CI is not staging certification');
    expect(launch).toContain('not `TECHNICAL_GO`');
    expect(launch).toContain('explicit written authorization');
    expect(read('docs/PRODUCTION-CHECKLIST.md')).toContain('explicit, written authorization');
  });
});
