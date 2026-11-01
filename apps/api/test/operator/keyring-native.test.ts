import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, chmodSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const dirs: string[] = [];
const at = '2099-01-15T12:00:00Z';
function dir() { const p = mkdtempSync(join(process.env.SF_WINDOWS_TEST_ROOT || tmpdir(), 'keyring-')); chmodSync(p, 0o700); dirs.push(p); return p; }
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/stripe-evidence/keyring.ts'), ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: '' } });
function generate(path: string, cohort: string, version = 'v1') {
  const r = run('generate', '--cohort', cohort, '--version', version, '--out', path);
  expect(r.status, r.stderr).toBe(0); const entry = JSON.parse(readFileSync(path, 'utf8')) as { key: string };
  expect(entry.key.length).toBeGreaterThan(0); expect(r.stdout + r.stderr).not.toContain(entry.key); return entry;
}
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
describe('keyring CLI with real native file creation', () => {
  it('generates, assembles, validates and stages rotation without printing keys', () => {
    const p = dir(), a = join(p, 'a.json'), b = join(p, 'b.json'), c = join(p, 'c.json'), ring = join(p, 'ring.json'), next = join(p, 'next.json');
    const entries = [generate(a, '2099-01'), generate(b, '2099-02'), generate(c, '2099-01', 'v2')];
    for (const r of [run('assemble', '--entry', a, '--entry', b, '--at', at, '--out', ring), run('validate', '--keyring', ring, '--at', at), run('rotate-phase1', '--keyring', ring, '--entry', c, '--at', at, '--out', next)]) {
      expect(r.status, r.stderr).toBe(0);
      for (const e of entries) expect(r.stdout + r.stderr).not.toContain(e.key);
    }
    const keys = JSON.parse(readFileSync(next, 'utf8')).keys as { kek_version: string; active: boolean }[];
    expect(keys.find(k => k.kek_version === 'v2')?.active).toBe(false);
    if (process.platform === 'linux') expect(statSync(next).mode & 0o777).toBe(0o600);
    else {
      const acl = spawnSync('icacls.exe', [next], { encoding: 'utf8' });
      expect(acl.status).toBe(0); expect(acl.stdout).not.toContain('(I)');
      expect(acl.stdout.split(/\r?\n/).filter(l => /:\(/.test(l))).toHaveLength(1);
    }
  });
  it('refuses an existing destination and reports only a safe error code', () => {
    const p = join(dir(), 'existing.json'); writeFileSync(p, 'synthetic-original');
    const r = run('generate', '--cohort', '2099-01', '--version', 'v1', '--out', p);
    expect(r.status).toBe(1); expect(r.stderr).toContain('EXISTS'); expect(r.stderr).not.toContain(p);
    expect(readFileSync(p, 'utf8')).toBe('synthetic-original');
  });
  it('rejects relative paths without an insecure output fallback', () => {
    const r = run('generate', '--cohort', '2099-01', '--version', 'v1', '--out', 'relative.json');
    expect(r.status).toBe(1); expect(r.stderr).toContain('PATH');
  });
  it('rejects symlink/junction output directories without touching their target', () => {
    const p = dir(), target = join(p, 'target'), link = join(p, 'link'); mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    const r = run('generate', '--cohort', '2099-01', '--version', 'v1', '--out', join(link, 'secret'));
    expect(r.status).toBe(1); expect(existsSync(join(target, 'secret'))).toBe(false);
  });
  it('does not print malformed secret input in JSON parser exceptions', () => {
    const p = join(dir(), 'broken.json'), marker = 'SYNTHETIC_PRIVATE_KEY_MATERIAL'; writeFileSync(p, '{' + marker);
    const r = run('assemble', '--entry', p, '--at', at, '--out', join(dir(), 'out'));
    expect(r.status).toBe(1); expect(r.stderr).toContain('OPERATION_FAILED'); expect(r.stdout + r.stderr).not.toContain(marker);
  });
});
