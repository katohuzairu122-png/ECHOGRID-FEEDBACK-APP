import process from 'node:process';
import { Buffer } from 'node:buffer';
import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, linkSync, symlinkSync, chmodSync, openSync, closeSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSecretFileExclusive, destroySecretFile } from '../index.js';
let dir;
before(() => { dir = mkdtempSync(join(process.env.SF_WINDOWS_TEST_ROOT || tmpdir(), 'sf-destroy-')); });
after(() => rmSync(dir, { recursive: true, force: true }));
const bytes = Buffer.from('synthetic-private-evidence');
function make(name) { const p = join(dir, name); writeSecretFileExclusive(p, bytes); return p; }
it('verified destruction removes the original owner-only file', () => {
  const p = make('original'); destroySecretFile(p); assert.equal(existsSync(p), false);
});
it('missing destinations fail closed without creating a file', () => {
  const p = join(dir, 'missing'); assert.throws(() => destroySecretFile(p), { code: 'MISSING' }); assert.equal(existsSync(p), false);
});
it('hardlinked destinations and both contents remain untouched', () => {
  const p = make('linked'), alias = p + '-alias'; linkSync(p, alias);
  assert.throws(() => destroySecretFile(p), { code: 'VERIFY' });
  assert.deepEqual(readFileSync(p), bytes); assert.deepEqual(readFileSync(alias), bytes);
});
it('symlink destinations never overwrite or delete the target', () => {
  const p = make('target'), alias = p + '-symlink'; symlinkSync(p, alias);
  assert.throws(() => destroySecretFile(alias)); assert.equal(existsSync(alias), true); assert.deepEqual(readFileSync(p), bytes);
});
it('junction/symlink parent traversal is rejected before mutation', () => {
  const alias = dir + '-link'; symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const p = make('parent-target');
  try { assert.throws(() => destroySecretFile(join(alias, 'parent-target'))); assert.deepEqual(readFileSync(p), bytes); }
  finally { rmSync(alias, { recursive: process.platform === 'win32', force: true }); }
});
it('invalid paths and arguments fail without creating or opening destinations', () => {
  for (const p of ['', 'relative', null, {}, '\ud800']) assert.throws(() => destroySecretFile(p));
});
it('Linux permissive existing file is refused without permission repair or mutation', { skip: process.platform !== 'linux' }, () => {
  const p = make('permissive'); chmodSync(p, 0o644);
  assert.throws(() => destroySecretFile(p), { code: 'VERIFY' }); assert.deepEqual(readFileSync(p), bytes);
});
it('Linux retained reader observes zeroing before unlink without an extra hard link', { skip: process.platform !== 'linux' }, () => {
  const p = make('zeroing'), fd = openSync(p, 'r');
  try { destroySecretFile(p); const seen = Buffer.alloc(bytes.length, 255); assert.equal(readSync(fd, seen, 0, seen.length, 0), bytes.length); assert.ok(seen.every(v => v === 0)); }
  finally { closeSync(fd); }
});

it('Windows permissive existing DACL is refused without repair or mutation', { skip: process.platform !== 'win32' }, () => {
  const p = make('permissive-dacl'); execFileSync('icacls.exe', [p, '/grant', '*S-1-1-0:(R)']);
  assert.throws(() => destroySecretFile(p), { code: 'VERIFY' }); assert.deepEqual(readFileSync(p), bytes);
});
it('missing ancestor reports MISSING without creating directories', () => {
  assert.throws(() => destroySecretFile(join(dir, 'absent-parent', 'file')), { code: 'MISSING' });
});
