# DEV-01-R6: enforced Linux hard-link prerequisite

The R5 hard-link denial failure exposed a missing implementation guard, not merely a CI configuration issue. With `fs.protected_hardlinks=0`, an unprivileged foreign UID can create another link to a file in a searchable directory despite its `0600` mode. Snapshot link-count checks cannot prevent that race. R6 therefore requires the kernel protection rather than accepting this host and hoping the link count remains stable.

## Runtime contract

Linux requires a readable, root-owned regular `/proc/sys/fs/protected_hardlinks` on procfs with exactly `1\n`. The implementation traverses `/proc`, `sys`, `fs` and the leaf through no-follow directory descriptors, verifies procfs identity, and parses bounded input. Disabled, missing, malformed, symlinked or unverifiable evidence fails closed with `UNSUPPORTED`.

The check runs before exclusive destination creation and inside every verification, including before writing and final completion. No environment override or production fallback exists. A later verification failure invokes the existing identity-safe cleanup and preserves separate cleanup-error reporting. This prevents new files being created on the current disabled host, including in private directories; it is deliberately a uniform prerequisite.

Root/mount administrators remain trusted. A privileged actor changing the setting immediately after a check is outside the distinct-user threat model. Reading procfs does not itself certify a hostile kernel, privileged mount substitution or unusual filesystem semantics.

No host sysctl, existing assertion, ancestor check, file mode or ownership rule is relaxed. Windows code and consumers are unchanged.

## Verification split

- `test/hardlink-disabled.test.mjs` runs against the real production module on an actual disabled host. It checks refusal before file creation in private/sticky parents and preservation of existing files/symlink targets. Four cases; it requires actual setting zero and does not pretend to certify permitted creation.
- `test/hardlink-policy.c` tests exact parser acceptance/rejection with eight assertions, including enabled, disabled and malformed values. This is a parser unit test, not simulated kernel enforcement.
- Existing POSIX tests retain same-owner hard-link tampering, independent-user denial and 16-process concurrent creation assertions. These and the existing fault suite require a real enabled host for successful file creation. They have not been weakened or replaced by mocked success.
- Fault injection is narrowed to destination write descriptors, so identity/close faults cannot accidentally intercept procfs prerequisite evidence.

Build with the existing pinned toolchain. Run the parser test on Linux:

```
cc -Wall -Wextra -Werror test/hardlink-policy.c -o build/hardlink-policy
./build/hardlink-policy
node --test test/hardlink-disabled.test.mjs
```

On an enabled host, run the existing POSIX and fault suites on Node 22 and 24, under root and an unprivileged identity. Do not change a host-wide sysctl merely to satisfy this test run. The disabled-host test must be run separately on its intended host; its enabled-host precondition failure is not a pass.

## Certification status

Actual Linux native build and disabled-host rejection tests pass. Successful-creation suites now fail at the enforced prerequisite on the available host; their reported failures must not be counted as security passes. Windows MSVC/NTFS and separate-user execution remain unavailable. Parser acceptance of `1\n` does not substitute for an actual enabled Linux kernel test. No DEV-01 certification, DEV-02 advancement, merge or release approval is granted.
