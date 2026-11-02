import { it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout, clearTimeout } from 'node:timers';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { writeSecretFileExclusive, destroySecretFile } from '../index.js';
let dir;
before(() => { dir = mkdtempSync(join(process.env.SF_WINDOWS_TEST_ROOT || tmpdir(), 'sf-crash-')); });
after(() => rmSync(dir, { recursive: true, force: true }));
for (const point of ['prepared', 'partial']) {
  it(`forced process termination at ${point} retains protected evidence and refuses overwrite`, { timeout: 20000 }, async () => {
    const path = join(dir, point);
    const child = fork(fileURLToPath(new URL('./fixtures/crash-writer.mjs', import.meta.url)), [point, path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    const exited = once(child, 'exit');
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('fixture readiness timed out')), 10000);
        child.once('message', message => message?.ready === true ? resolve() : reject(new Error('unexpected fixture message')));
        child.once('error', reject);
        child.once('exit', () => reject(new Error('fixture exited before readiness')));
      });
      assert.equal(child.kill('SIGKILL'), true); await exited;
      assert.deepEqual([...readFileSync(path)], point === 'partial' ? [17, 29, 43] : []);
      if (process.platform === 'linux') assert.equal(statSync(path).mode & 0o7777, 0o600);
      assert.throws(() => writeSecretFileExclusive(path, new Uint8Array([99])), { code: 'EXISTS' });
      // Explicit recovery verifies existing owner/ACL/identity before removal.
      // No automatic deletion, resume, publication or success claim on restart.
      destroySecretFile(path); assert.equal(existsSync(path), false);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
}
