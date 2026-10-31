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
const CI = process.env.GITHUB_ACTIONS === 'true';
const ROOT_ENV = process.env.SF_WINDOWS_TEST_ROOT;
const SECRET = Buffer.from('TOPSECRET-KEK-MATERIAL-0123456789');
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };
const EVERYONE = '*S-1-1-0';
const icacls = (...args) => spawnSync('icacls.exe', args, { encoding: 'utf8' });

/** A fixture that cannot be built is a skip on a developer machine but a FAILURE on the hosted runner, so a security case cannot disappear silently there. */
const unavailable = (tc, why, { soft = false } = {}) => { if (CI && !soft) assert.fail(`required fixture unavailable in CI: ${why}`); tc.skip(why); };

// P/Invoke helpers (kept as plain PowerShell text; no JavaScript interpolation inside the C# sources).
const PROBE_PS = String.raw`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SfProbe {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateFileW(string n, uint access, uint share, IntPtr sa, uint disp, uint flags, IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static int OpenWithDelete(string path) {
    IntPtr h = CreateFileW(path, 0x10000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (h == new IntPtr(-1)) return Marshal.GetLastWin32Error();
    CloseHandle(h); return 0;
  }
}
"@
foreach ($p in ($env:SF_PROBE_PATHS -split '\|')) { Write-Output ([SfProbe]::OpenWithDelete($p)) }`;
const ACL_PS = String.raw`
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class SfAcl {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, IntPtr size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] static extern uint SetNamedSecurityInfoW(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  public static uint Apply(string path, string sddl) {
    IntPtr sd; if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, IntPtr.Zero)) return (uint)Marshal.GetLastWin32Error();
    bool present, def; IntPtr dacl;
    if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out def) || !present) { LocalFree(sd); return 1; }
    uint r = SetNamedSecurityInfoW(path, 1, 0x80000004u, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
    LocalFree(sd); return r;
  }
}
"@
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
exit ([int][SfAcl]::Apply($env:SF_PATH, "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$sid)(XA;;FR;;;WD;(Member_of {SID(BU)}))"))`;
const powershellEnv = (script, env) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', env: { ...process.env, ...env } });

describe('secure-file Windows ancestor trust (R9)', { skip: !win || (!ROOT_ENV && !CI) }, () => {
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

  /** Renaming an ancestor away and back proves no handle from a finished or rejected attempt is still held. */
  const assertReleased = (t) => { renameSync(t.a, `${t.a}-r`); renameSync(`${t.a}-r`, t.a); };
  before(() => {
    // Without a dedicated tree the stock ancestors of Temp are refused anyway, so every rejection case would pass for the wrong reason.
    if (!ROOT_ENV) assert.fail('SF_WINDOWS_TEST_ROOT must name a dedicated NTFS tree');
    root = mkdtempSync(join(ROOT_ENV || tmpdir(), 'sfa-'));
  });
  after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

  for (const [right, name] of [['DC', 'delete-child'], ['D', 'delete'], ['WDAC', 'write-DACL'], ['WO', 'write-owner'], ['WD', 'add-file'], ['AD', 'add-subdirectory'], ['WA', 'write-attributes'], ['WEA', 'write-extended-attributes']]) {
    for (const where of ['a', 'b', 'leaf']) {
      it(`rejects an ancestor (${where}) granting Everyone ${name}, before anything is created`, () => {
        const t = tree(); grant(t[where], `(${right})`);
        assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT');
        nothingCreated(t); assertReleased(t);
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
    if (icacls(t.b, '/setowner', '*S-1-5-32-545').status !== 0) { unavailable(tc, 'cannot assign an unprivileged owner without SeRestore/SeTakeOwnership'); return; }
    assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT'); nothingCreated(t); assertReleased(t);
    const u = tree();
    if (icacls(u.b, '/setowner', '*S-1-5-32-544').status !== 0) { unavailable(tc, 'cannot assign the Administrators owner'); return; }
    writeSecretFileExclusive(u.target, SECRET); assert.equal(existsSync(u.target), true);
  });

  it('treats NT SERVICE\\TrustedInstaller as a trusted owner, but not a look-alike owner', (tc) => {
    const t = tree();
    if (icacls(t.b, '/setowner', '*S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464').status !== 0) { unavailable(tc, 'cannot assign the TrustedInstaller owner on this host', { soft: true }); return; }
    writeSecretFileExclusive(t.target, SECRET); assert.equal(existsSync(t.target), true);
    const near = tree(); // a service SID in the same authority with one sub-authority different must NOT be trusted
    if (icacls(near.b, '/setowner', '*S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478465').status !== 0) { unavailable(tc, 'cannot assign a look-alike service owner', { soft: true }); return; }
    assert.equal(code(() => writeSecretFileExclusive(near.target, SECRET)), 'UNSAFE_PARENT'); nothingCreated(near);
  });

  it('fails closed on an ACE form it does not understand (conditional/callback ACE) on an ancestor', (tc) => {
    const t = tree();
    const r = powershellEnv(ACL_PS, { SF_PATH: t.b });
    if (r.status !== 0) { unavailable(tc, `could not create a conditional ACE (exit ${r.status}): ${(r.stderr || '').slice(0, 160)}`); return; }
    assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'UNSAFE_PARENT'); nothingCreated(t); assertReleased(t);
  });

  it('a junction or symlink ancestor is still refused, and the target tree is untouched', (tc) => {
    const t = tree(); const link = join(root, `link${++n}`);
    try { symlinkSync(t.a, link, 'junction'); } catch (e) { if (e.code === 'EPERM') { unavailable(tc, 'link creation needs privilege'); return; } throw e; }
    assert.equal(code(() => writeSecretFileExclusive(join(link, 'b', 'leaf', 'k'), SECRET)), 'SYMLINK'); nothingCreated(t); assertReleased(t);
  });

  it('while a handle is open EVERY directory on the path refuses an open with DELETE access (what a rename/delete needs), and accepts it again after close or abort', () => {
    // Discriminating probe: a plain rename of an ancestor already fails whenever a descendant is open, so it proves nothing. The new defence is that each ancestor
    // handle excludes FILE_SHARE_DELETE; opening the directory with DELETE access and full sharing must therefore hit a sharing violation (32) on each of them.
    const t = tree(); const dirs = [t.leaf, t.b, t.a, t.base, root];
    const probe = () => { const r = powershellEnv(PROBE_PS, { SF_PROBE_PATHS: dirs.join('|') }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim().split(/\r?\n/).map(Number); };
    assert.deepEqual(probe(), dirs.map(() => 0), 'precondition: with no handle open every directory can be opened with DELETE access');
    const f = SecureFile.prepare(t.target);
    try {
      assert.deepEqual(probe(), dirs.map(() => 32), 'prepared: every ancestor must refuse DELETE access (ERROR_SHARING_VIOLATION)');
      f.verify(); f.write(SECRET);
      assert.deepEqual(probe(), dirs.map(() => 32), 'still held after verify and write');
      for (const dir of [t.leaf, t.b, t.a]) assert.throws(() => renameSync(dir, `${dir}-moved`), (e) => ['EBUSY', 'EPERM', 'EACCES'].includes(e.code), `rename ${dir}`);
      f.close();
    } finally { f.abort(); }
    assert.deepEqual(probe(), dirs.map(() => 0), 'closed: every handle is released');
    assertReleased(t);
  });

  it('an aborted attempt releases every held directory', () => {
    const t = tree(); const dirs = [t.leaf, t.b, t.a, t.base];
    SecureFile.prepare(t.target).abort();
    const r = powershellEnv(PROBE_PS, { SF_PROBE_PATHS: dirs.join('|') }); assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split(/\r?\n/).map(Number), dirs.map(() => 0));
  });

  it('a creation that fails because the name exists also releases every held directory', () => {
    const t = tree(); writeSecretFileExclusive(t.target, SECRET);
    assert.equal(code(() => writeSecretFileExclusive(t.target, SECRET)), 'EXISTS'); assertReleased(t);
  });

  it('holding the ancestors does not stop a second handle on the same tree, nor on a sibling file, nor a later creation', () => {
    const t = tree(); const f1 = SecureFile.prepare(join(t.leaf, 'one')); const f2 = SecureFile.prepare(join(t.leaf, 'two'));
    try { f1.verify(); f1.write(SECRET); f2.verify(); f2.write(SECRET); f1.close(); f2.close(); } finally { f1.abort(); f2.abort(); }
    writeSecretFileExclusive(join(t.leaf, 'three'), SECRET);
    assert.deepEqual(readdirSync(t.leaf).sort(), ['one', 'three', 'two']);
  });

});
