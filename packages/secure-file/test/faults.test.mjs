import { it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, existsSync, statSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { writeSecretFileExclusive } from '../build/Release/fault-wrapper.mjs';
const native = createRequire(import.meta.url)('../build/Release/secure_file_faults.node');
let dir;
before(() => { dir = mkdtempSync(join(tmpdir(), 'sf-fault-')); });
after(() => { delete process.env.SF_TEST_FAULT; rmSync(dir, { recursive: true, force: true }); });
function failure(fn) { try { fn(); } catch (e) { return e; } assert.fail('expected failure'); }
for (const fault of ['registration', 'tag']) {
  it(`${fault} failure releases resources and GC does not double-free`, async () => {
    assert.equal(typeof globalThis.gc, 'function', '--expose-gc required');
    process.env.SF_TEST_FAULT = fault;
    for (let i = 0; i < 100; ++i) {
      const p = join(dir, `${fault}-${i}`);
      assert.equal(failure(() => native.prepare(p)).code, 'INTERNAL');
      assert.equal(existsSync(p), false);
    }
    delete process.env.SF_TEST_FAULT;
    for (let i = 0; i < 5; ++i) { globalThis.gc(); await setTimeout(10); }
  });
}
it('repeated abort and garbage collection remove unfinished files', async () => {
  const p = join(dir, 'abort'); const h = native.prepare(p);
  native.abort(h); native.abort(h); assert.equal(existsSync(p), false);
  const q = join(dir, 'gc'); (() => { native.prepare(q); })();
  for (let i = 0; i < 10 && existsSync(q); ++i) { globalThis.gc(); await setTimeout(10); }
  assert.equal(existsSync(q), false);
});
it('explicit cleanup failure is observable and repeated abort preserves failure', () => {
  const p = join(dir, 'cleanup'); const h = native.prepare(p);
  process.env.SF_TEST_FAULT = 'cleanup';
  try {
    assert.equal(failure(() => native.abort(h)).code, 'CLEANUP');
    assert.equal(failure(() => native.abort(h)).code, 'CLEANUP');
    assert.equal(statSync(p).size, 0);
  } finally { delete process.env.SF_TEST_FAULT; }
});
for (const fault of ['partial', 'partial-cleanup']) {
  it(`${fault}: write error preserved with independent cleanup outcome`, () => {
    const p = join(dir, fault); const h = native.prepare(p); native.verify(h);
    process.env.SF_TEST_FAULT = fault;
    try {
      const e = failure(() => native.write(h, new Uint8Array([1, 2, 3])));
      assert.equal(e.code, 'WRITE'); assert.ok(e.osError > 0);
      if (fault === 'partial-cleanup') {
        assert.equal(e.cleanupError.code, 'CLEANUP'); assert.ok(e.cleanupError.osError > 0);
        assert.equal(statSync(p).size, 1);
      } else { assert.equal(e.cleanupError, undefined); assert.equal(existsSync(p), false); }
    } finally { delete process.env.SF_TEST_FAULT; }
  });
}
it('substituted destinations are untouched and original removal is not falsely claimed', () => {
  const p = join(dir, 'substitute'); const h = native.prepare(p);
  renameSync(p, p + '-original'); writeFileSync(p, 'replacement');
  const e = failure(() => native.verify(h));
  assert.equal(e.code, 'IDENTITY'); assert.equal(e.cleanupError.code, 'IDENTITY');
  assert.equal(readFileSync(p, 'utf8'), 'replacement');
  assert.equal(statSync(p + '-original').size, 0);
});

it('unknown initial identity is never unlinked and cleanup uncertainty is reported', () => {
  const p = join(dir, 'identity-unknown'); process.env.SF_TEST_FAULT = 'identity';
  try {
    const e = failure(() => native.prepare(p));
    assert.equal(e.code, 'CREATE'); assert.equal(e.cleanupError.code, 'IDENTITY');
    assert.equal(statSync(p).size, 0);
  } finally { delete process.env.SF_TEST_FAULT; }
});

it('one-shot API preserves WRITE when cleanup also fails', () => {
  const p = join(dir, 'one-shot'); process.env.SF_TEST_FAULT = 'partial-cleanup';
  try {
    const e = failure(() => writeSecretFileExclusive(p, new Uint8Array([1, 2, 3])));
    assert.equal(e.code, 'WRITE'); assert.equal(e.cleanupError.code, 'CLEANUP');
    assert.equal(statSync(p).size, 1);
  } finally { delete process.env.SF_TEST_FAULT; }
});

it('file-close failure is reported rather than returning successful completion', () => {
  const p = join(dir, 'close'); const h = native.prepare(p); native.verify(h);
  native.write(h, new Uint8Array([1, 2])); process.env.SF_TEST_FAULT = 'close';
  try {
    assert.equal(failure(() => native.close(h)).code, 'FLUSH');
    assert.equal(existsSync(p), false);
  } finally { delete process.env.SF_TEST_FAULT; }
});
