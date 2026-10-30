/* global Buffer, process, setImmediate, setTimeout */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, statSync, readFileSync, writeFileSync, symlinkSync, linkSync, renameSync, chmodSync, chownSync, existsSync, lstatSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureFile, writeSecretFileExclusive } from '../index.js';

/** Linux adversarial suite. Skipped (and reported as skipped, never as passed) on other platforms. */
const posix = process.platform !== 'win32';
const SECRET = Buffer.from('TOPSECRET-KEK-MATERIAL-0123456789');
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const err = (fn) => { try { fn(); } catch (e) { return e; } return null; };
const mode = (p) => statSync(p).mode & 0o7777;

describe('secure-file (POSIX)', { skip: !posix }, () => {
  let root;
  const d = (n) => { const p = join(root, n); mkdirSync(p, { mode: 0o700 }); chmodSync(p, 0o700); return p; };
  before(() => { root = mkdtempSync(join(tmpdir(), 'sf-')); chmodSync(root, 0o700); });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('creates the file exactly 0600 regardless of umask, owned by the caller, with the bytes intact', () => {
    for (const um of [0o000, 0o022, 0o077, 0o277, 0o777]) {
      const old = process.umask(um);
      try {
        const p = join(d(`um${um.toString(8)}`), 'k.json');
        writeSecretFileExclusive(p, SECRET);
        assert.equal(mode(p), 0o600, `umask ${um.toString(8)}`);
        assert.equal(statSync(p).uid, process.geteuid());
        assert.equal(statSync(p).nlink, 1);
        assert.deepEqual(readFileSync(p), SECRET);
      } finally { process.umask(old); }
    }
  });

  it('never overwrites: an existing file is untouched', () => {
    const p = join(d('exist'), 'k'); writeFileSync(p, 'ORIGINAL', { mode: 0o644 });
    assert.equal(code(() => writeSecretFileExclusive(p, SECRET)), 'EXISTS');
    assert.equal(readFileSync(p, 'utf8'), 'ORIGINAL'); assert.equal(mode(p), 0o644);
  });

  it('refuses a final symlink (existing or dangling) and never creates or writes through it', () => {
    const dir = d('final-link'); const victim = join(dir, 'victim');
    writeFileSync(victim, 'VICTIM'); symlinkSync(victim, join(dir, 'to-existing'));
    symlinkSync(join(dir, 'new-target'), join(dir, 'dangling'));
    assert.equal(code(() => writeSecretFileExclusive(join(dir, 'to-existing'), SECRET)), 'EXISTS');
    assert.equal(code(() => writeSecretFileExclusive(join(dir, 'dangling'), SECRET)), 'EXISTS');
    assert.equal(readFileSync(victim, 'utf8'), 'VICTIM'); assert.equal(existsSync(join(dir, 'new-target')), false);
  });

  it('refuses a symlink anywhere in the directory path', () => {
    const real = d('real'); symlinkSync(real, join(root, 'link-dir'));
    assert.equal(code(() => writeSecretFileExclusive(join(root, 'link-dir', 'k'), SECRET)), 'SYMLINK');
    assert.deepEqual(readdirSync(real), []);
    mkdirSync(join(real, 'sub'), { mode: 0o700 }); symlinkSync(join(real, 'sub'), join(real, 'sublink'));
    assert.equal(code(() => writeSecretFileExclusive(join(real, 'sublink', 'k'), SECRET)), 'SYMLINK');
  });

  it('refuses relative paths, dot components, empty components, NUL bytes, non-strings, missing parents and file-as-directory', () => {
    const dir = d('paths');
    for (const bad of ['k', './k', `${dir}/../k`, `${dir}/./k`, `${dir}//k`, '', '/']) assert.ok(['PATH', 'ARGUMENT'].includes(code(() => SecureFile.prepare(bad))), bad);
    assert.equal(code(() => SecureFile.prepare(`${dir}/k\0x`)), 'ARGUMENT');
    assert.equal(code(() => SecureFile.prepare(123)), 'ARGUMENT');
    assert.equal(code(() => SecureFile.prepare(join(dir, 'missing', 'k'))), 'CREATE');
    writeFileSync(join(dir, 'afile'), 'x');
    assert.equal(code(() => SecureFile.prepare(join(dir, 'afile', 'k'))), 'NOT_DIRECTORY');
    assert.equal(code(() => SecureFile.prepare(`${dir}/${'a'.repeat(300)}`)), 'PATH');
    assert.deepEqual(readdirSync(dir).sort(), ['afile']);
  });

  it('refuses a parent others can write to unless it is sticky; refuses a parent owned by someone else', () => {
    const open = join(root, 'wide'); mkdirSync(open); chmodSync(open, 0o777);
    assert.equal(code(() => writeSecretFileExclusive(join(open, 'k'), SECRET)), 'UNSAFE_PARENT');
    const grp = join(root, 'grp'); mkdirSync(grp); chmodSync(grp, 0o770);
    assert.equal(code(() => writeSecretFileExclusive(join(grp, 'k'), SECRET)), 'UNSAFE_PARENT');
    const sticky = join(root, 'sticky'); mkdirSync(sticky); chmodSync(sticky, 0o1777);
    writeSecretFileExclusive(join(sticky, 'k'), SECRET); assert.equal(mode(join(sticky, 'k')), 0o600);
    if (process.geteuid() === 0) {
      const foreign = join(root, 'foreign'); mkdirSync(foreign); chmodSync(foreign, 0o700); chownSync(foreign, 65534, 65534);
      assert.equal(code(() => writeSecretFileExclusive(join(foreign, 'k'), SECRET)), 'UNSAFE_PARENT');
    }
  });

  it('applies the directory policy to EVERY ancestor, not only the immediate parent', () => {
    const top = d('anc'); const mid = join(top, 'mid'); const leaf = join(mid, 'leaf'); mkdirSync(leaf, { recursive: true });
    for (const p of [mid, leaf]) chmodSync(p, 0o700);
    writeSecretFileExclusive(join(leaf, 'ok'), SECRET);
    chmodSync(mid, 0o770); // group-writable ancestor: could be renamed/replaced by group members
    assert.equal(code(() => writeSecretFileExclusive(join(leaf, 'k'), SECRET)), 'UNSAFE_PARENT');
    chmodSync(mid, 0o757);
    assert.equal(code(() => writeSecretFileExclusive(join(leaf, 'k'), SECRET)), 'UNSAFE_PARENT');
    chmodSync(mid, 0o1777); // sticky world-writable ancestor is allowed (like /tmp)
    writeSecretFileExclusive(join(leaf, 'k2'), SECRET);
    chmodSync(mid, 0o700);
    assert.deepEqual(readdirSync(leaf).sort(), ['k2', 'ok']);
  });

  it('refuses an ancestor owned by another user', { skip: process.geteuid() !== 0 }, () => {
    const top = d('anc-own'); const mid = join(top, 'mid'); const leaf = join(mid, 'leaf'); mkdirSync(leaf, { recursive: true });
    chmodSync(mid, 0o755); chmodSync(leaf, 0o700); chownSync(mid, 65534, 65534);
    assert.equal(code(() => writeSecretFileExclusive(join(leaf, 'k'), SECRET)), 'UNSAFE_PARENT');
    assert.deepEqual(readdirSync(leaf), []);
  });

  it('rejects, rather than alters, over-long and ill-formed path strings (no truncation, no U+FFFD substitution)', () => {
    const dir = d('strings');
    const tail = '/kk';
    const longPath = dir + '/' + 'a'.repeat(4094 - dir.length - 1 - tail.length) + tail + '\u20ac'; // multi-byte char straddles the 4096-byte limit
    assert.ok(Buffer.byteLength(longPath) > 4096 - 1);
    assert.equal(code(() => SecureFile.prepare(longPath)), 'ARGUMENT');
    assert.equal(code(() => SecureFile.prepare(`${dir}/n\uD800`)), 'ARGUMENT'); // lone surrogate
    assert.equal(code(() => SecureFile.prepare(`${dir}/n\uFFFD`)), 'ARGUMENT'); // literal replacement character
    assert.deepEqual(readdirSync(dir), []);
  });

  it('SecureFile cannot be constructed directly, and a foreign object is not accepted as a handle', () => {
    assert.throws(() => new SecureFile({}), TypeError);
    assert.throws(() => new SecureFile(Symbol('x'), {}), TypeError);
  });

  it('fails closed on a filesystem that cannot guarantee owner-only semantics', () => {
    assert.equal(code(() => SecureFile.prepare('/proc/k')), 'UNSUPPORTED');
    assert.equal(code(() => SecureFile.prepare('/sys/kernel/k')), 'UNSUPPORTED');
  });

  it('write before verify, use after close/abort, and double close are lifecycle errors; nothing is written early', () => {
    const p = join(d('life'), 'k');
    const f = SecureFile.prepare(p);
    assert.equal(code(() => f.write(SECRET)), 'STATE');
    assert.equal(code(() => f.close()), 'STATE');
    assert.equal(statSync(p).size, 0);
    f.verify(); assert.equal(code(() => f.verify()), 'STATE');
    f.write(SECRET); f.close();
    assert.equal(code(() => f.write(SECRET)), 'STATE'); assert.equal(code(() => f.close()), 'STATE');
    f.abort(); // idempotent and must NOT remove a completed file
    assert.deepEqual(readFileSync(p), SECRET);
    const g = SecureFile.prepare(join(d('life2'), 'k')); g.abort(); g.abort();
    assert.equal(code(() => g.verify()), 'STATE');
  });

  it('verify fails closed (and removes the file) when the mode is loosened after creation', () => {
    const p = join(d('chmod'), 'k'); const f = SecureFile.prepare(p);
    chmodSync(p, 0o644);
    assert.equal(code(() => f.verify()), 'VERIFY');
    assert.equal(existsSync(p), false);
    assert.equal(code(() => f.write(SECRET)), 'STATE');
  });

  it('a hard link planted after creation is detected before any secret byte is written', () => {
    const dir = d('hardlink'); const p = join(dir, 'k'); const f = SecureFile.prepare(p);
    linkSync(p, join(dir, 'alias'));
    assert.equal(code(() => f.verify()), 'VERIFY');
    assert.equal(existsSync(p), false);
    assert.equal(statSync(join(dir, 'alias')).size, 0); // the alias never saw a secret
  });

  it('detects rename substitution of the entry; cleanup never deletes the substituted file', () => {
    const dir = d('subst'); const p = join(dir, 'k'); const f = SecureFile.prepare(p);
    renameSync(p, join(dir, 'moved'));
    writeFileSync(p, 'ATTACKER', { mode: 0o600 });
    assert.equal(code(() => f.verify()), 'IDENTITY');
    assert.equal(readFileSync(p, 'utf8'), 'ATTACKER'); // not deleted
    assert.equal(readFileSync(join(dir, 'moved')).length, 0); // the real file got no secret
    // substitution by a symlink
    const q = join(dir, 'k2'); const g = SecureFile.prepare(q);
    renameSync(q, join(dir, 'moved2')); symlinkSync(join(dir, 'moved2'), q);
    assert.equal(code(() => g.verify()), 'IDENTITY');
    assert.equal(lstatSync(q).isSymbolicLink(), true);
  });

  it('substitution between verify and write is caught by the pre-write recheck', () => {
    const dir = d('toctou'); const p = join(dir, 'k'); const f = SecureFile.prepare(p); f.verify();
    renameSync(p, join(dir, 'moved')); writeFileSync(p, 'ATTACKER', { mode: 0o600 });
    assert.equal(code(() => f.write(SECRET)), 'IDENTITY');
    assert.equal(readFileSync(p, 'utf8'), 'ATTACKER'); assert.equal(readFileSync(join(dir, 'moved')).length, 0);
  });

  it('ownership change after creation is detected', { skip: process.geteuid() !== 0 }, () => {
    const p = join(d('chown'), 'k'); const f = SecureFile.prepare(p);
    chownSync(p, 65534, 65534);
    assert.equal(code(() => f.verify()), 'VERIFY'); assert.equal(existsSync(p), false);
  });

  it('accepts only Buffer/Uint8Array; strings and other typed arrays are refused and the file is removed', () => {
    for (const bad of ['string-secret', new Uint16Array(4), 42, null, {}]) {
      const p = join(d('type' + Math.random().toString(16).slice(2)), 'k'); const f = SecureFile.prepare(p); f.verify();
      assert.equal(code(() => f.write(bad)), 'ARGUMENT'); assert.equal(existsSync(p), false);
    }
    const p = join(d('u8'), 'k'); writeSecretFileExclusive(p, new Uint8Array([1, 2, 3])); assert.deepEqual(readFileSync(p), Buffer.from([1, 2, 3]));
  });

  it('writes in multiple calls and large payloads without short writes; enforces the size ceiling and removes the file', () => {
    const p = join(d('big'), 'k'); const big = Buffer.alloc(900 * 1024, 0xab);
    const f = SecureFile.prepare(p); f.verify(); f.write(big); f.write(Buffer.from('tail')); f.close();
    assert.equal(statSync(p).size, big.length + 4); assert.equal(mode(p), 0o600);
    const q = join(d('too-big'), 'k'); const g = SecureFile.prepare(q); g.verify();
    assert.equal(code(() => g.write(Buffer.alloc(2 * 1024 * 1024))), 'TOO_LARGE'); assert.equal(existsSync(q), false);
    const r = join(d('too-big2'), 'k'); const h = SecureFile.prepare(r); h.verify(); h.write(Buffer.alloc(1024 * 1024));
    assert.equal(code(() => h.write(Buffer.from('x'))), 'TOO_LARGE'); assert.equal(existsSync(r), false);
  });

  it('empty payload creates a verified empty 0600 file', () => {
    const p = join(d('empty'), 'k'); writeSecretFileExclusive(p, Buffer.alloc(0)); assert.equal(statSync(p).size, 0); assert.equal(mode(p), 0o600);
  });

  it('exactly one of many concurrent creators wins; losers fail EXISTS and leave the winner intact', async () => {
    const p = join(d('race'), 'k');
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => new Promise((res) => setImmediate(() => {
      try { writeSecretFileExclusive(p, Buffer.from(`writer-${i}`)); res('ok'); } catch (e) { res(e.code); }
    }))));
    assert.equal(results.filter((r) => r === 'ok').length, 1);
    assert.equal(results.filter((r) => r === 'EXISTS').length, 15);
    assert.match(readFileSync(p, 'utf8'), /^writer-\d+$/); assert.equal(mode(p), 0o600);
  });

  it('error objects never contain the path, the secret, or a stack of file contents', () => {
    const dir = d('leak'); const p = join(dir, 'k'); writeFileSync(p, 'x');
    const e = err(() => writeSecretFileExclusive(p, SECRET));
    const blob = JSON.stringify({ m: e.message, c: e.code, o: e.osError, k: Object.keys(e) });
    assert.ok(!blob.includes(dir) && !blob.includes('TOPSECRET') && !blob.includes(root));
    const w = SecureFile.prepare(join(dir, 'k2')); w.verify();
    const e2 = err(() => w.write('TOPSECRET-as-string'));
    assert.ok(!JSON.stringify([e2.message, e2.code]).includes('TOPSECRET'));
  });

  it('an unprivileged other user cannot read, replace, rename or delete the file, even in a sticky world-writable directory', { skip: process.geteuid() !== 0 }, () => {
    const dir = join(root, 'shared'); mkdirSync(dir); chmodSync(dir, 0o1777); chmodSync(root, 0o711);
    const p = join(dir, 'k'); writeSecretFileExclusive(p, SECRET);
    const attacker = `
      const fs = require('fs'); const out = {};
      const t = (n, f) => { try { f(); out[n] = 'ALLOWED'; } catch (e) { out[n] = e.code; } };
      t('read', () => fs.readFileSync(${JSON.stringify(p)}));
      t('append', () => fs.appendFileSync(${JSON.stringify(p)}, 'x'));
      t('unlink', () => fs.unlinkSync(${JSON.stringify(p)}));
      t('rename', () => fs.renameSync(${JSON.stringify(p)}, ${JSON.stringify(p + '.x')}));
      t('chmod', () => fs.chmodSync(${JSON.stringify(p)}, 0o666));
      t('hardlink', () => fs.linkSync(${JSON.stringify(p)}, ${JSON.stringify(p + '.hl')}));
      console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ['-e', attacker], { uid: 65534, gid: 65534, encoding: 'utf8' });
    chmodSync(root, 0o700);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.read, 'EACCES'); assert.equal(out.append, 'EACCES'); assert.equal(out.unlink, 'EPERM'); assert.equal(out.rename, 'EPERM'); assert.equal(out.chmod, 'EPERM');
    assert.ok(['EPERM', 'EACCES'].includes(out.hardlink), out.hardlink); // protected_hardlinks forbids linking files you cannot read/write
    assert.deepEqual(readFileSync(p), SECRET);
  });

  it('does not leak the descriptors to child processes (O_CLOEXEC)', () => {
    const p = join(d('cloexec'), 'k'); const f = SecureFile.prepare(p); f.verify();
    const r = spawnSync('sh', ['-c', 'ls /proc/self/fd | wc -l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    const inheritedBefore = Number(r.stdout.trim());
    f.write(SECRET); f.close();
    const r2 = spawnSync('sh', ['-c', 'ls /proc/self/fd | wc -l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
    assert.equal(Number(r2.stdout.trim()), inheritedBefore);
  });

  it('garbage-collecting an unfinished handle removes its half-created file', { skip: typeof globalThis.gc !== 'function' }, async () => {
    const dir = d('gc'); const p = join(dir, 'k');
    (() => { SecureFile.prepare(p); })();
    if (typeof globalThis.gc === 'function') { for (let i = 0; i < 5 && existsSync(p); i++) { globalThis.gc(); await new Promise((r) => setTimeout(r, 20)); } assert.equal(existsSync(p), false); }
    else return; // not exercised without --expose-gc (the test:native script passes it)
  });
});
