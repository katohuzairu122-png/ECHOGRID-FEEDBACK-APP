# Block 04 — security and evidence lifecycle hardening

Scope: development verification; no publication redesign, automatic recovery,
financial changes, schema changes, deployment or merge authorization.

## Production correction

Windows `close_h` retained its stored handle after a failed CloseHandle call,
allowing cleanup to retry an uncertain numeric handle. It now relinquishes stored
ownership before closing. Windows `sf_close` also retains separate CLEANUP
uncertainty before aborting remaining resources when file closure fails. No filename is reopened; a substitute is never used as a cleanup target.
The fixed error contains codes/OS status only, not secrets or paths.

## Test boundaries

- Test-only native wrappers inject ENOSPC/ERROR_DISK_FULL at the first write,
  after a one-byte write, and during flush. Cleanup failure can be injected
  separately. Real filesystem creation, ACL checks and identity checks still run.
- Windows fault builds use a separate explicit gyp target and binary. Production
  binding.gyp does not compile or load fault wrappers. No install hook enables them.
- Destruction failure tests retain the existing file, including zeroed or partially
  zeroed data. A failed operation is never treated as confirmed removal.
- A subprocess holds an actual native file open, acknowledges a prepared or partial
  write barrier, and is forcibly terminated. Tests verify the surviving bytes,
  overwrite refusal and explicit verified-handle destruction after restart.
- This is process-crash testing, not power-loss or physical-disk-full certification.
  Faults simulate OS error returns; no host disks are filled or sysctls changed.
- Existing forensic tests retain registration-before-write, no destruction audit on
  failure, and observable audit failure after successful removal. Filesystem success
  and successful audit persistence remain distinct outcomes.

## Recovery contract and residual risk

A crash may leave an empty or partial, protected file at the requested name. A
retry must not overwrite or assume the file is complete. Preserve its audit
obligation, inspect under the existing operator authorization, and use the existing
verified destruction operation if separately authorized. There is no automatic
sweeper, resume, label rebinding, or publication of interrupted output.

A registered export is not proof of successful writing. Successful removal followed
by audit failure requires reconciliation; it is not permission to fabricate a
successful audit record. Export labels remain historical audit identifiers, not
persisted inode bindings. Zeroing is best-effort on SSD/COW/snapshots. Directory
unlink/audit atomicity, real power-loss durability and full-disk devices are not
certified by these tests. Trusted same-user/administrative actors, unsupported
filesystems and the 1 MiB native limit retain their existing boundaries.

Hosted CI provides positive Linux and NTFS runtime evidence. The local host's
protected_hardlinks=0 blocks positive Linux tests; it is not changed to obtain a pass.
Final test counts and independent review belong to the exact-commit completion report.
