# DEV-01-R9: Windows ancestor-directory trust

The merged DEV-01 already refused an ancestor whose owner or ACL let an untrusted principal mutate it (`directory_safe`). R9 completes that boundary; it does not replace it.

## Policy (every directory from the volume root to the final parent)

- **Owner** must be the operator (token user), SYSTEM, `BUILTIN\Administrators` or `NT SERVICE\TrustedInstaller` (added in R9). Ownership implies `WRITE_DAC`, so an untrusted owner is refused regardless of the DACL.
- **No untrusted allow ACE** (one that applies to the directory itself, i.e. not inherit-only) may grant any of: `DELETE`, `FILE_DELETE_CHILD`, `WRITE_DAC`, `WRITE_OWNER`, `FILE_ADD_FILE`, `FILE_ADD_SUBDIRECTORY`, `FILE_WRITE_EA`, `FILE_WRITE_ATTRIBUTES`, or any generic/maximum-allowed/system-security bit. Read/traverse grants to others are fine.
- **Unknown ACE forms** (callback, conditional, object) and malformed SIDs/ACLs **fail closed**.
- Reparse points (junction, symlink, mount point) on any component are refused; the volume must be local fixed NTFS with persistent ACLs.
- A refused path creates nothing.

## New in R9: no replacement window while the file handle is live

Every ancestor handle (volume root through final parent) is kept open until `close`/`abort`, opened **without `FILE_SHARE_DELETE`**. Renaming or deleting any directory on the path needs `DELETE` access, which conflicts with that share mode, so no directory on the path can be renamed or replaced between the trust check and close. This is independent of the ACL analysis and also holds against a trusted principal. All handles are released on close, abort and every error path.

## Limits (stated, not hidden)

- Stock volume roots grant `Authenticated Users` create rights and are refused by design. Use a dedicated NTFS tree (CI uses `SF_WINDOWS_TEST_ROOT`).
- Deny ACEs are ignored: a grant is judged as if no deny existed (conservative: may refuse more than strictly needed, never less).
- Once the file handle is closed the share-mode protection ends; from then on only the ACL policy applies. Same-user, SYSTEM and Administrators remain trusted.
- A process holding a directory open with `DELETE` access makes `prepare` fail (sharing violation): fail closed, availability only.

## Evidence

Adversarial tests: `test/secure-file.win32-ancestors.test.js` (any NTFS host; `SF_WINDOWS_TEST_ROOT` recommended) and `test/secure-file.win32-accounts.test.js` (real distinct local account, created by `test/ci/windows-fixture.ps1 -Operation Ancestor` on a disposable hosted runner). No Linux code, `keyring.ts` or `forensic.ts` changed.
