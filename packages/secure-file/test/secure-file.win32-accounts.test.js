/* global Buffer, process */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeSecretFileExclusive } from '../index.js';

/**
 * S08-SEC-FILE-1 DEV-01-R9: ancestor trust against a REAL distinct local Windows account. Run only by test/ci/windows-fixture.ps1 -Operation Ancestor on a
 * disposable hosted runner, which creates the account and the case trees and exports SF_ANCESTOR_CASES and SF_ACCOUNT_SID. Without them the suite is skipped
 * (never passed): it is not a developer-workstation test.
 */
const cases = process.env.SF_ANCESTOR_CASES; const accountSid = process.env.SF_ACCOUNT_SID;
const enabled = process.platform === 'win32' && !!cases && !!accountSid;
const SECRET = Buffer.from('SYNTHETIC-SECRET-NOT-REAL');
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };

describe('secure-file ancestors owned or controlled by a distinct Windows account (R9)', { skip: !enabled }, () => {
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

  it('the account really is a distinct, unprivileged principal (the fixture is not vacuous)', () => {
    assert.match(accountSid, /^S-1-5-21-\d+-\d+-\d+-\d+$/);
    assert.notEqual(accountSid, 'S-1-5-18');
  });
});
