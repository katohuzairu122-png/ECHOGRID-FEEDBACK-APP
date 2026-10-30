/* global Buffer, process */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync, linkSync, renameSync, existsSync, openSync, closeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { SecureFile, writeSecretFileExclusive } from '../index.js';

/**
 * Windows adversarial suite for S08-SEC-FILE-1 DEV-01. It is skipped on every other platform and was NOT EXECUTED during DEV-01 (no Windows host in the
 * authoring environment); it must be run on the Windows 11 / NTFS host before the Windows implementation can be called verified.
 * Run from a non-elevated and (separately) an elevated shell; junction/symlink cases need Developer Mode for symlinks.
 */
const win = process.platform === 'win32';
const SECRET = Buffer.from('TOPSECRET-KEK-MATERIAL-0123456789');
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const icacls = (p) => spawnSync('icacls.exe', [p], { encoding: 'utf8' }).stdout;

describe('secure-file (Windows)', { skip: !win }, () => {
  let root;
  const d = (n) => { const p = join(root, n); mkdirSync(p); return p; };
  before(() => { root = mkdtempSync(join(tmpdir(), 'sf-')); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('creates the file with a protected owner-only DACL (no inherited ACE, no Everyone/Users/Administrators/SYSTEM) and exact bytes', () => {
    const p = join(d('acl'), 'k.json'); writeSecretFileExclusive(p, SECRET);
    assert.deepEqual(readFileSync(p), SECRET);
    const out = icacls(p);
    const aces = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /:\(/.test(l));
    assert.equal(aces.length, 1, out);
    assert.match(aces[0], new RegExp(userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.ok(!/\(I\)/.test(out), 'no inherited ACE'); assert.ok(/\(F\)/.test(aces[0]), 'full control for owner only');
    for (const w of ['Everyone', 'BUILTIN\\Users', 'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', 'Authenticated Users']) assert.ok(!out.includes(w), w);
  });

  it('never overwrites an existing file', () => {
    const p = join(d('exist'), 'k'); writeFileSync(p, 'ORIGINAL');
    assert.equal(code(() => writeSecretFileExclusive(p, SECRET)), 'EXISTS'); assert.equal(readFileSync(p, 'utf8'), 'ORIGINAL');
  });

  it('rejects relative, UNC, device-namespace, stream, dot, reserved-name, trailing-dot and bad-character paths', () => {
    const dir = d('paths');
    const bad = ['k', '.\\k', `${dir}\\..\\k`, `${dir}\\.\\k`, `\\\\server\\share\\k`, `\\\\?\\${dir}\\k`, `\\\\.\\${dir}\\k`, `${dir}\\k:stream`, `${dir}\\CON`, `${dir}\\nul.txt`, `${dir}\\k.`, `${dir}\\k `, `${dir}\\a*b`, `${dir}\\k\\`, `${dir}\\`, `${dir.replace('\\', '/')}/k`, 'C:k', ''];
    for (const b of bad) assert.ok(['PATH', 'ARGUMENT'].includes(code(() => SecureFile.prepare(b))), b);
  });

  it('refuses a junction (mount point) in the path and creates nothing in its target', () => {
    const real = d('real'); const j = join(root, 'junction');
    symlinkSync(real, j, 'junction'); // Node creates a real NTFS junction (no privilege needed); a failure here is a test-setup error, not a pass
    assert.equal(code(() => writeSecretFileExclusive(join(j, 'k'), SECRET)), 'SYMLINK'); assert.equal(existsSync(join(real, 'k')), false);
    assert.equal(code(() => writeSecretFileExclusive(join(root, 'junction'), SECRET)), 'EXISTS'); // junction as the final component is never followed or replaced
  });

  it('refuses a directory symlink in the path and a file symlink as the target', (t) => {
    const real = d('real2'); const l = join(root, 'dirlink');
    try { symlinkSync(real, l, 'dir'); } catch (e) { if (e.code === 'EPERM') { t.skip('symlink creation needs Developer Mode or privilege'); return; } throw e; }
    assert.equal(code(() => writeSecretFileExclusive(join(l, 'k'), SECRET)), 'SYMLINK');
    const victim = join(real, 'victim'); writeFileSync(victim, 'V'); const fl = join(real, 'filelink'); symlinkSync(victim, fl, 'file');
    assert.ok(['EXISTS', 'SYMLINK'].includes(code(() => writeSecretFileExclusive(fl, SECRET)))); assert.equal(readFileSync(victim, 'utf8'), 'V');
  });

  it('write before verify and use after close/abort are lifecycle errors', () => {
    const p = join(d('life'), 'k'); const f = SecureFile.prepare(p);
    assert.equal(code(() => f.write(SECRET)), 'STATE'); assert.equal(statSync(p).size, 0);
    f.verify(); f.write(SECRET); f.close(); assert.equal(code(() => f.write(SECRET)), 'STATE'); f.abort();
    assert.deepEqual(readFileSync(p), SECRET);
  });

  it('opens with share mode 0: no other open of the file succeeds while the handle is live', () => {
    const p = join(d('share'), 'k'); const f = SecureFile.prepare(p);
    let opened = true; try { closeSync(openSync(p, 'r')); } catch { opened = false; }
    assert.equal(opened, false); f.abort();
  });

  it('while the handle is open nobody can rename it, hard-link it, or widen its DACL (share mode 0 closes the substitution windows verify() also checks)', () => {
    const dir = d('tamper'); const p = join(dir, 'k'); const f = SecureFile.prepare(p);
    assert.throws(() => renameSync(p, join(dir, 'moved')));
    assert.throws(() => linkSync(p, join(dir, 'alias')));
    const grant = spawnSync('icacls.exe', [p, '/grant', 'Everyone:R'], { encoding: 'utf8' });
    assert.notEqual(grant.status, 0, grant.stdout);
    f.verify(); f.write(SECRET); f.close();
    assert.ok(!icacls(p).includes('Everyone'));
    assert.deepEqual(readFileSync(p), SECRET);
  });

  it('after close the file stays owner-only and a second creation at the same name is refused', () => {
    const dir = d('after'); const p = join(dir, 'k'); writeSecretFileExclusive(p, SECRET);
    assert.equal(code(() => writeSecretFileExclusive(p, Buffer.from('other'))), 'EXISTS');
    assert.deepEqual(readFileSync(p), SECRET);
    assert.equal(icacls(p).split(/\r?\n/).filter((l) => /:\(/.test(l)).length, 1);
  });

  it('abort removes the half-created file; verify failure removes it; error objects carry no path or secret', () => {
    const dir = d('abort'); const p = join(dir, 'k'); const f = SecureFile.prepare(p); f.abort(); assert.equal(existsSync(p), false);
    writeFileSync(join(dir, 'x'), 'x'); let e; try { writeSecretFileExclusive(join(dir, 'x'), SECRET); } catch (er) { e = er; }
    const blob = JSON.stringify([e.message, e.code, e.osError]); assert.ok(!blob.includes(dir) && !blob.includes('TOPSECRET'));
  });

  it('accepts only Buffer/Uint8Array', () => {
    const p = join(d('type'), 'k'); const f = SecureFile.prepare(p); f.verify();
    assert.equal(code(() => f.write('string')), 'ARGUMENT'); assert.equal(existsSync(p), false);
  });
});
