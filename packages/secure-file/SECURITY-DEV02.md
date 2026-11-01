# DEV-02 operator integration and verified destruction

Development only. No production certification, merge or deployment authorization.

Keyring generate/assemble/rotate outputs use the existing exclusive writer. The
operator adapter requires absolute paths and, on Linux, an immediate directory
owned by the operator with exact 0700. Native traversal independently enforces
ancestor trust, supported filesystem and hardlink prerequisites. Windows retains
all ancestor handles and establishes the protected operator-only DACL at creation.

ForensicReader accepts a file-operations dependency supplied by the operator CLI.
Without it, export/destruction fails closed; audited reads remain available. The
Worker graph has no import of the native package. Read auditing precedes
decryption; export registration precedes native writing. Export buffers are wiped
in finally, including registration/output failures. Existing-file refusal remains
exclusive at the native boundary; a refused export attempt may leave its registered
audit obligation, rather than fabricating successful output or deleting evidence.

`destroySecretFile` is an additive one-shot native operation, not a pathname-based
overwrite. It shares validated traversal with creation but opens existing files
without truncation or permission repair. Existing handles are close-only on failure
until ownership, exact protection, single-link identity, size (at most 1 MiB),
zeroing, flush and final verification all succeed. It then removes through the
same Windows handle or verified Linux parent descriptor/entry identity. Failure
never deletes an unverified existing object. Partial zeroing, failed flush/removal,
or audit failure remain failures; operators must reconcile them. A destroyed audit
record is appended only after native success. No database or authorization changes.

Missing-write-argument cleanup was also corrected: only a validated addon external
may be aborted; absent/foreign handles are rejected before dereference. The external
finalizer retains ownership of native storage. Cleanup errors remain distinct from
the original argument/write failure.

## Residual limitations

- Root, SYSTEM, trusted administrators and same-user processes remain trusted.
- Network filesystems and unsafe or unverifiable ancestry fail closed.
- Zeroing is best-effort sanitization, not physical secure erasure (SSD, snapshots,
  copy-on-write and backups may retain data).
- Crashes, full disks or audit-store failure can leave incomplete obligations.
  Destruction's unlink is not claimed as a crash-durable transactional audit.
- Export labels historically are audit labels, not persisted inode identities.
  This change validates the current opened object; it does not invent a durable
  label-to-file authorization mapping or claim to detect prior same-user swaps.
- The native payload limit is 1 MiB. Larger forensic exports fail closed, retaining
  registration evidence; no insecure fallback or relaxed limit is introduced.
- Windows existing files must already have the exact native owner-only protected
  DACL. Legacy insecure exports are refused, not silently repaired.

## Verification and review

DEV-02-A exact commit f31105bfd1075ba41937be8d8fd075ab224c29bf passed all four
Ubuntu 24.04/Windows Server 2022, Node 22/24 jobs in Actions run 41269119403.
Independent static review found no material issue in A or the missing-argument fix.
B review found no critical defect and recommended size conversion hardening,
missing-ancestor parity and additional refusal/audit-failure tests; these are applied.
Final exact-head runtime results are recorded in the PR completion report, not
inferred from earlier commits. Local host protected_hardlinks=0 prevents positive
native certification here; actual supported Linux and NTFS tests run in CI.
