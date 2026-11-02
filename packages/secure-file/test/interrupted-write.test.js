/* global process */
/* Regression: an abrupt process exit after a verified write does not publish atomically.
 * This test documents an existing limitation, verifies confidential remnants, and
 * exercises explicit identity-safe recovery using synthetic bytes only.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { writeSecretFileExclusive, destroySecretFile } from '../index.js';

it('abrupt writer exit preserves owner-only partial file until explicit recovery', () => {
  const root = mkdtempSync(join(process.platform === 'win32'
    ? (process.env.SF_WINDOWS_TEST_ROOT || tmpdir()) : tmpdir(), 'sf-crash-'));
  const file = join(root, 'synthetic-partial');
  try {
    const moduleUrl = pathToFileURL(resolve('index.js')).href;
    const script = `
      const { SecureFile } = await import(process.argv[1]);
      const f = SecureFile.prepare(process.argv[2]);
      f.verify();
      f.write(new Uint8Array([11, 22, 33]));
      process.exit(0); // bypasses close/abort/finalizers; synthetic interrupted operation
    `;
    const child = spawnSync(process.execPath,
      ['--input-type=module', '-e', script, moduleUrl, file],
      { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15000 });
    assert.equal(child.error, undefined, 'interrupted child could not start');
    assert.equal(child.status, 0, `interrupted child failed: ${child.stderr}`);
    assert.equal(existsSync(file), true);
    assert.deepEqual([...readFileSync(file)], [11, 22, 33]);
    if (process.platform !== 'win32') {
      assert.equal(statSync(file).mode & 0o7777, 0o600);
    }
    assert.throws(() => writeSecretFileExclusive(file, new Uint8Array([44])), e => e.code === 'EXISTS');
    assert.deepEqual([...readFileSync(file)], [11, 22, 33]);
    destroySecretFile(file);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
