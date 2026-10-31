# S08-SEC-FILE-1 DEV-01-R5

Development candidate only. No consumer integration, release certification or financial authorization.

## Ownership and failure contract

The Node-API external owns native storage after successful registration. A subsequent type-tagging failure aborts OS resources but leaves storage to the registered finalizer. Failed registration retains caller ownership. Test-only translation units inject both failures; production objects have no fault switches.

Operation failures retain `code` and `osError`. A separate `cleanupError: { code, osError }` reports failure to remove or identify the original object. Explicit `abort()` throws if cleanup is incomplete; repeated abort preserves that failure. Do not infer successful deletion from a failed operation. GC is not reliable cleanup or a recovery workflow: a finalizer emits only a fixed diagnostic on cleanup failure, with no path or contents. Failed Windows handle closure can retain resources until process exit. The caller must arrange recovery outside this primitive; it must not blindly unlink a pathname.

POSIX cleanup verifies device/inode against the retained directory handle. Initial identity-query failure leaves the empty entry intact and reports uncertainty. A changed or missing name is not proof that the original inode was deleted. The check/unlink pair is not atomic; the existing caller/root-owned ancestor and sticky-directory policy excludes distinct-user entry replacement. Same-UID/root mutation remains outside that guarantee. No secure erasure or crash-atomic deletion is claimed.

## Windows ancestor policy

Every directory, including the volume root, is inspected through its opened handle before sensitive file creation. Reparse points, non-directories, unavailable/invalid descriptors, unknown applicable ACE forms and untrusted owners fail closed. Permitted ancestor owners/mutators are the operator SID, LocalSystem and Builtin Administrators; the newly created file remains operator-only. Read/traverse grants to other principals are allowed. Inherit-only ACEs do not apply to the directory. Generic rights are mapped before checking mutation grants. Denies are never used to justify an otherwise unsafe allow.

This conservative policy can reject standard Windows volume roots, including roots granting Users subdirectory-creation rights or owned by another service principal. Do not weaken or repair production ACLs to run tests. A disposable NTFS volume/tree satisfying the policy is required; compatibility with real target-volume ACLs remains unverified. Holding anchored handles does not promise pathname stability against the trusted operator or administrators.

## Reproduction

Build with pinned node-gyp 12.2.0 and verified local Node headers (NAPI_VERSION=9):

```
pnpm --filter @echo-grid-feedback/secure-file build:native --nodedir=<verified-node-header-directory>
```

On Linux, from this package:

```
NODE_INCLUDE_DIR=<verified-node-header-directory>/include/node node test/build-faults.mjs
node --expose-gc --test test/secure-file.posix.test.js
node --expose-gc --test test/faults.test.mjs
```

Repeat on Node 22 and 24, as root and an unprivileged identity. Faults cover registration/tagging, repeated abort, GC, unlink failure, partial writes with successful/failed cleanup, substituted names, unknown initial identity, one-shot error preservation and close failure. The fault module and copied JS wrapper live under ignored build output, never in the production native module.

On a real Windows MSVC/NTFS host, run `node --expose-gc --test test/secure-file.win32.test.js`. `SF_WINDOWS_TEST_ROOT` may select the disposable test volume. Missing symlink privileges are setup failures, not successful/skipped security checks.

The separate `test/windows-independent-user.ps1` requires a synthetic secret file created by this module containing exactly `SF_TEST_SYNTHETIC`, a readable sibling canary containing `SF_PUBLIC`, and a PSCredential for an existing unprivileged account. Supply credentials interactively or via an approved credential store, never command-line passwords. The harness checks a distinct SID, non-administrator token, sibling-canary traversal, read/append/delete/rename denial, and unchanged fixture. It does not provision accounts or change ACLs.

## Observed limits (2026-10-31)

Linux actual native build and Node 22.23.4/24.19.0 loading succeeded. In a disposable Debian trixie container (image digest sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4, offline network), `/` and `/tmp` are root-owned. Tests use overlayfs, not an ext4 certification environment. Each runtime: root suite 24 pass / 1 fail / 0 skip; unprivileged suite 22 pass / 0 fail / 3 root-only skips. Each runtime/identity fault suite: 10 pass / 0 fail / 0 skip.

The root failure is the existing independent-user hardlink-denial assertion: the host has `fs.protected_hardlinks=0`. No host sysctl, guard or expected assertion was changed. This is an unsatisfied security prerequisite and remains a failed test, not a pass. The outer sandbox root maps to overflow UID 65534 due to its user namespace and cannot satisfy the ancestor policy; the disposable container resolves root ownership without altering host directories.

Windows MSVC, NTFS, independent-user runtime and Windows cleanup fault injection remain unexecuted. A Linux build is not Windows compilation evidence. Required platform verification is incomplete; NO-GO for DEV-01 completion, DEV-02, merge or deployment.
