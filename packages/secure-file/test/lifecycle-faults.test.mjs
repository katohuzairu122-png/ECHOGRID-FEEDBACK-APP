import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, constants } from 'node:os';
import { join } from 'node:path';
import { writeSecretFileExclusive, destroySecretFile } from '../build/Release/fault-wrapper.mjs';
let dir;
const bytes = new Uint8Array([17, 29, 43]);
const diskFull = process.platform === 'win32' ? 112 : constants.errno.ENOSPC;
before(() => { dir = mkdtempSync(join(process.env.SF_WINDOWS_TEST_ROOT || tmpdir(), 'sf-lifecycle-')); });
after(() => { delete process.env.SF_TEST_FAULT; rmSync(dir, { recursive: true, force: true }); });
function fail(fn) { try { fn(); } catch (e) { return e; } assert.fail('operation unexpectedly succeeded'); }
for (const fault of ['disk-full', 'disk-partial', 'disk-partial-cleanup', 'flush-full', 'flush-full-cleanup']) {
  it(`${fault}: failed creation preserves operation and independent cleanup evidence`, () => {
    const path = join(dir, fault); process.env.SF_TEST_FAULT = fault;
    try {
      const e = fail(() => writeSecretFileExclusive(path, bytes));
      assert.equal(e.code, fault.startsWith('flush') ? 'FLUSH' : 'WRITE');
      assert.equal(e.osError, diskFull);
      if (fault.endsWith('cleanup')) {
        assert.equal(e.cleanupError.code, 'CLEANUP'); assert.ok(e.cleanupError.osError > 0);
        assert.deepEqual([...readFileSync(path)], fault.startsWith('flush') ? [...bytes] : [17]);
      } else { assert.equal(e.cleanupError, undefined); assert.equal(existsSync(path), false); }
    } finally { delete process.env.SF_TEST_FAULT; }
    if (existsSync(path)) {
      assert.throws(() => writeSecretFileExclusive(path, bytes), { code: 'EXISTS' });
      destroySecretFile(path); assert.equal(existsSync(path), false);
    }
  });
}
for (const fault of ['disk-full', 'disk-partial', 'flush-full']) {
  it(`${fault}: failed destruction retains the file and never claims removal`, () => {
    const path = join(dir, `destroy-${fault}`); writeSecretFileExclusive(path, bytes);
    process.env.SF_TEST_FAULT = fault;
    try {
      const e = fail(() => destroySecretFile(path));
      assert.equal(e.code, fault === 'flush-full' ? 'FLUSH' : 'WRITE'); assert.equal(e.osError, diskFull);
      assert.deepEqual([...readFileSync(path)], fault === 'disk-full' ? [...bytes] : fault === 'disk-partial' ? [0, 29, 43] : [0, 0, 0]);
    } finally { delete process.env.SF_TEST_FAULT; }
    destroySecretFile(path); assert.equal(existsSync(path), false);
  });
}
it('Linux directory flush failure is not reported as a successful write', { skip: process.platform !== 'linux' }, () => {
  const path = join(dir, 'directory-flush'); process.env.SF_TEST_FAULT = 'directory-flush';
  try { assert.equal(fail(() => writeSecretFileExclusive(path, bytes)).code, 'FLUSH'); assert.equal(existsSync(path), false); }
  finally { delete process.env.SF_TEST_FAULT; }
});
it('Windows lost closing handle reports incomplete cleanup without reopening the pathname', { skip: process.platform !== 'win32' }, () => {
  delete process.env.SF_TEST_STALE_HANDLE_REUSED;
  const path = join(dir, 'file-close'); process.env.SF_TEST_FAULT = 'file-close';
  try {
    const e = fail(() => writeSecretFileExclusive(path, bytes));
    assert.equal(e.code, 'FLUSH'); assert.equal(e.cleanupError.code, 'CLEANUP');
    assert.equal(process.env.SF_TEST_STALE_HANDLE_REUSED, undefined, 'must not retry disposition or closure on an uncertain handle');
    assert.deepEqual([...readFileSync(path)], [...bytes]);
  } finally { delete process.env.SF_TEST_FAULT; }
  destroySecretFile(path); assert.equal(existsSync(path), false);
});
