// Real production-module rejection tests for a host with protected_hardlinks=0.
// These do not replace the enabled-host security suites.
import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, rmSync, readFileSync, existsSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureFile, writeSecretFileExclusive } from '../index.js';
let root;
before(() => {
  assert.equal(readFileSync('/proc/sys/fs/protected_hardlinks', 'utf8'), '0\n', 'this suite requires the disabled-host test environment');
  root = mkdtempSync(join(tmpdir(), 'sf-disabled-'));
});
after(() => { if (root) rmSync(root, { recursive: true, force: true }); });
for (const permissions of [0o700, 0o1777]) {
  it(`rejects creation before any file exists in mode ${permissions.toString(8)}`, () => {
    const dir = join(root, String(permissions)); mkdirSync(dir); chmodSync(dir, permissions);
    const p = join(dir, 'secret');
    assert.throws(() => SecureFile.prepare(p), { code: 'UNSUPPORTED' });
    assert.equal(existsSync(p), false);
    assert.throws(() => writeSecretFileExclusive(p, new Uint8Array([1, 2, 3])), { code: 'UNSUPPORTED' });
    assert.deepEqual(readdirSync(dir), []);
  });
}
it('refusal preserves existing content', () => {
  const p = join(root, 'existing'); writeFileSync(p, 'original');
  assert.throws(() => writeSecretFileExclusive(p, new Uint8Array([1])), { code: 'UNSUPPORTED' });
  assert.equal(readFileSync(p, 'utf8'), 'original');
});
it('refusal never follows a final symlink', () => {
  const victim = join(root, 'victim'), link = join(root, 'link');
  writeFileSync(victim, 'original'); symlinkSync(victim, link);
  assert.throws(() => writeSecretFileExclusive(link, new Uint8Array([1])), { code: 'UNSUPPORTED' });
  assert.equal(readFileSync(victim, 'utf8'), 'original');
});
