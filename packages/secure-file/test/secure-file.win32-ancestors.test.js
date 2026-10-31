/* global Buffer, process */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, renameSync, existsSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecureFile, writeSecretFileExclusive } from '../index.js';

/**
 * S08-SEC-FILE-1 DEV-01-R9: Windows ancestor-directory trust. Every directory from the volume root to the final parent must be owned by the operator or a
 * privileged OS principal and must not grant an untrusted principal any right that lets it rename, delete, replace or take over an entry (DELETE,
 * FILE_DELETE_CHILD, WRITE_DAC, WRITE_OWNER, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, extended-attribute/attribute writes). Unknown ACE forms fail closed.
 * A rejected path leaves nothing behind. Run against a dedicated NTFS tree (SF_WINDOWS_TEST_ROOT in CI): stock volume roots grant Users creation rights and
 * are therefore refused by design. Skipped on other platforms; setup failures that need privilege skip the one case, they never pass it.
 */
const win = process.platform === 'win32';
const SECRET = Buffer.from('TOPSECRET-KEK-MATERIAL-0123456789');
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const EVERYONE = '*S-1-1-0';
const icacls = (...args) => spawnSync('icacls.exe', args, { encoding: 'utf8' });
const powershell = (script) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8' });

describe('secure-file Windows ancestor trust (R9)', { skip: !win }, () => {
  let root;
  let n = 0;
  /** base/a/b/leaf: `leaf` is the final parent, `b` and `a` are ancestors. */
  const tree = () => {
    const base = join(root, `t${++n}`); const a = join(base, 'a'); const b = join(a, 'b'); const leaf = join(b, 'leaf');
    mkdirSync(leaf, { recursive: true });
    return { base, a, b, leaf, target: join(leaf, 'k') };
  };
  const grant = (dir, rights) => { const r = icacls(dir, '/grant', `${EVERYONE}:${rights}`); assert.equal(r.status, 0, `ACL fixture setup failed: ${r.stdout}${r.stderr}`); };
  const nothingCreated = (t) => assert.deepEqual(readdirSync(t.leaf), [], 'a rejected path must create nothing');

  before(() => { root = mkdtempSync(join(process.env.SF_WINDOWS_TEST_ROOT || tmpdir(), 'sfa-')); });
  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  for (const [right, name] of [['DC', 'delete-child'], ['D', 'delete'], ['WDAC', 'write-DACL'], ['WO', 'write-owner'], ['WD', 'add-file'], ['AD', 'add-subdirectory'], ['WA', 'write-attributes'], ['WEA', 'write-extended-attributes']]) {
    for (const where of ['a', 'b', 'leaf']) {
      it(`rejects an ancestor (${where}) granting Everyone ${name}, before anything is created`, () => {
        const t = tree(); grant(t[where], `(${right})`);
        assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT');
        nothingCreated(t);
      });
    }
  }

  it('also rejects broad inheritable grants (Modify, Full control) on an ancestor', () => {
    for (const rights of ['(OI)(CI)(M)', '(OI)(CI)(F)', '(M)']) {
      const t = tree(); grant(t.a, rights);
      assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT', rights); nothingCreated(t);
    }
  });

  it('accepts a trusted private tree, and read/traverse-only grants to others', () => {
    const t = tree(); writeSecretFileExclusive(t.target, SECRET); assert.equal(existsSync(t.target), true);
    for (const rights of ['(RX)', '(R)', '(X)']) {
      const u = tree(); grant(u.a, rights); grant(u.leaf, rights);
      writeSecretFileExclusive(u.target, SECRET); assert.equal(existsSync(u.target), true, rights);
    }
  });

  it('ignores an inherit-only ACE on the ancestor itself, while the directories that actually inherit it are still judged on their own ACL', () => {
    const t = tree();
    assert.equal(icacls(t.b, '/inheritance:d').status, 0); // b and leaf keep explicit copies of their ACEs and no longer follow a
    assert.equal(icacls(t.leaf, '/inheritance:d').status, 0);
    grant(t.a, '(CI)(IO)(M)'); // applies to a's children only, never to a itself
    writeSecretFileExclusive(t.target, SECRET); assert.equal(existsSync(t.target), true);
    const u = tree(); grant(u.a, '(CI)(M)'); // same grant without inherit-only applies to the directory itself and propagates to its children
    assert.equal(code(() => writeSecretFileExclusive(u.target, SECRET)), 'UNSAFE_PARENT'); nothingCreated(u);
  });

  it('rejects an ancestor owned by an unprivileged principal, and accepts one owned by a privileged group', (tc) => {
    const t = tree();
    if (icacls(t.b, '/setowner', '*S-1-5-32-545').status !== 0) { tc.skip('cannot assign an unprivileged owner without SeRestore/SeTakeOwnership'); return; }
    assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT'); nothingCreated(t);
    const u = tree();
    if (icacls(u.b, '/setowner', '*S-1-5-32-544').status !== 0) { tc.skip('cannot assign the Administrators owner'); return; }
    writeSecretFileExclusive(u.target, SECRET); assert.equal(existsSync(u.target), true);
  });

  it('fails closed on an ACE form it does not understand (conditional/callback ACE) on an ancestor', (tc) => {
    const t = tree();
    const sddl = 'D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$sid)(XA;;FR;;;WD;(Member_of {SID(BU)}))';
    const script = `$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $p='${t.b.replace(/'/g, "''")}'; $acl=Get-Acl -LiteralPath $p; $acl.SetSecurityDescriptorSddlForm(("${sddl}").Replace('$sid',$sid),'Access'); Set-Acl -LiteralPath $p -AclObject $acl`;
    const r = powershell(script);
    if (r.status !== 0) { tc.skip(`could not create a conditional ACE: ${(r.stderr || '').slice(0, 120)}`); return; }
    assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT'); nothingCreated(t);
  });

  it('a junction or symlink ancestor is still refused, and the target tree is untouched', (tc) => {
    const t = tree(); const link = join(root, `link${++n}`);
    try { symlinkSync(t.a, link, 'junction'); } catch (e) { if (e.code === 'EPERM') { tc.skip('link creation needs privilege'); return; } throw e; }
    assert.equal(code(() => writeSecretFileExclusive(join(link, 'b', 'leaf', 'k'), SECRET)), 'SYMLINK'); nothingCreated(t);
  });

  it('while a handle is open no directory on the path can be renamed or replaced (replacement race), and renaming works again afterwards', () => {
    const t = tree(); const f = SecureFile.prepare(t.target);
    try {
      for (const dir of [t.leaf, t.b, t.a, t.base]) assert.throws(() => renameSync(dir, `${dir}-moved`), (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e.code), `rename ${dir}`);
      f.verify(); f.write(SECRET);
      assert.throws(() => renameSync(t.b, `${t.b}-moved`), undefined, 'still held after verify and write');
      f.close();
    } finally { f.abort(); }
    renameSync(t.b, `${t.b}-moved`); renameSync(`${t.b}-moved`, t.b); // released: ordinary renames work again
  });

  it('holding the ancestors does not stop a second handle on the same tree, nor on a sibling file, nor a later creation', () => {
    const t = tree(); const f1 = SecureFile.prepare(join(t.leaf, 'one')); const f2 = SecureFile.prepare(join(t.leaf, 'two'));
    try { f1.verify(); f1.write(SECRET); f2.verify(); f2.write(SECRET); f1.close(); f2.close(); } finally { f1.abort(); f2.abort(); }
    writeSecretFileExclusive(join(t.leaf, 'three'), SECRET);
    assert.deepEqual(readdirSync(t.leaf).sort(), ['one', 'three', 'two']);
  });

  it('an aborted attempt releases every held directory (no leaked handle blocks later renames)', () => {
    const t = tree();
    for (let i = 0; i < 20; i++) { const f = SecureFile.prepare(join(t.leaf, `x${i}`)); f.abort(); }
    assert.deepEqual(readdirSync(t.leaf), [], 'abort removes each half-created file');
    renameSync(t.a, `${t.a}-moved`); // would fail with a sharing violation if any handle leaked
    renameSync(`${t.a}-moved`, t.a);
  });
});

