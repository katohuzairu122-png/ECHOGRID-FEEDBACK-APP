/* global Buffer, process */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { writeSecretFileExclusive } from '../index.js';

/**
 * S08-SEC-FILE-1 DEV-01-R9: ancestor trust against a REAL distinct local Windows account. Run only by test/ci/windows-fixture.ps1 -Operation Ancestor on a
 * disposable hosted runner, which creates the account and the case trees and exports SF_ANCESTOR_CASES and SF_ACCOUNT_SID. Without them the suite is skipped
 * (never passed): it is not a developer-workstation test.
 */
const cases = process.env.SF_ANCESTOR_CASES; const accountSid = process.env.SF_ACCOUNT_SID;
const win = process.platform === 'win32';
const CI = process.env.GITHUB_ACTIONS === 'true';
const enabled = win && !!cases && !!accountSid;
const SECRET = Buffer.from('SYNTHETIC-SECRET-NOT-REAL');
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };

describe('secure-file ancestors owned or controlled by a distinct Windows account (R9)', { skip: !win || (!enabled && !CI) }, () => {
  it('the hosted-runner fixture exported the case root and the account SID (a missing fixture fails, it does not skip)', () => {
    assert.ok(cases && accountSid, 'SF_ANCESTOR_CASES and SF_ACCOUNT_SID must be set by windows-fixture.ps1 -Operation Ancestor');
  });

  for (const name of ['owned-by-account', 'account-modify', 'account-delete-child']) {
    it(`refuses a tree whose ancestor is ${name === 'owned-by-account' ? 'OWNED by the account' : name === 'account-modify' ? 'writable (Modify) by the account' : 'granted delete-child to the account'}, creating nothing`, () => {
      const inner = join(cases, name, 'inner');
      assert.equal(code(() => writeSecretFileExclusive(join(inner, 'k'), SECRET)), 'UNSAFE_PARENT');
      assert.deepEqual(readdirSync(inner), []);
      // and directly under the offending directory itself
      assert.equal(code(() => writeSecretFileExclusive(join(cases, name, 'k'), SECRET)), 'UNSAFE_PARENT');
      assert.equal(existsSync(join(cases, name, 'k')), false);
    });
  }

  it('accepts the operator-private tree and a tree where the account has read/traverse access only', () => {
    for (const name of ['private', 'account-read-only']) {
      const file = join(cases, name, 'inner', 'k');
      writeSecretFileExclusive(file, SECRET);
      assert.equal(existsSync(file), true, name);
      rmSync(file);
    }
  });

  it('the account really is a distinct, unprivileged principal (not the current user, not SYSTEM, not an Administrators member)', () => {
    assert.match(accountSid, /^S-1-5-21-\d+-\d+-\d+-\d+$/);
    const me = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout;
    assert.ok(me.includes('S-1-5-'), 'could not read the current user SID');
    assert.ok(!me.includes(accountSid), 'the test account must not be the account running the tests');
    const admins = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.SID.Value }) -join ','"], { encoding: 'utf8' });
    assert.equal(admins.status, 0, admins.stderr);
    assert.ok(!admins.stdout.split(',').map((s) => s.trim()).includes(accountSid), 'the test account must not be an Administrators member');
  });
});
