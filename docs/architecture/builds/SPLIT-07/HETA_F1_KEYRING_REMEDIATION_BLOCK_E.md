# HETA-01-F1-E — Policy-independent corrected keyring test copy

**Date:** 2026-10-20. **Verified main:** `a76dfe9cf5687a175803ee2cf3999f3e48e06366`.
**Dependency/base parent:** Block D `63ad6956c9ef29a116af5684ea78a554a2a3f328`, PR #146, unmerged with passing CI at preflight.
**Scope:** E1–E6 corrections and synthetic tests in a separately identified test-only copy. No runtime keyring adoption.

## Dependency and source provenance

PR #146 was verified open/mergeable with successful CI run [39431354231](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/39431354231). This branch descends directly from its exact head; it does not cherry-pick, duplicate or silently merge Block D. The single Block E PR targets main because the existing CI workflow only runs for main-targeting PRs. Until #146 merges, the full main comparison includes its unchanged ancestor work. Review the Block E delta against the named D parent. Do not merge this dependent PR before dependency disposition and independent review.

The original candidate fixture, manifest, Git blob `3755bc8ae519e2396b1cdbfef3a54b19e2be2fea` and SHA-256 `145620753b3f10c57fbaacfb805f7f54fd695862c7d1c3b5d5c9de8468c5a8c3` remain unchanged. The Block D report remains historical evidence for that defective snapshot.

The corrected copy is `apps/api/test/fixtures/heta-f1-keyring-remediated.ts`, identified independently as `heta-f1-keyring-test-remediation/E1-E6-v1`. Its separate manifest records SHA-256 `0330f74d0c7ff855632f78b1000aaa6aac219853895aa25bbd08f6a184551e03`. Tests verify both original and corrected provenance, allowing only checkout CRLF-to-LF normalization. The new identifier is a review-artifact identifier, not a key identity or new encryption version. Neither checksum is the missing Revision 3.3 design checksum.

## Corrections and exact regression mapping

Block D had six expected-failure cases across five D-X findings because D-X4 contained two limit cases. E6 explicitly remediates the separate D-M1 mutable-entry characterization. Therefore E1–E6 map to **seven primary ordinary regression cases**, not six one-to-one renamed cases. All `it.fails` markers are removed from the corrected keyring suites; no assertion was weakened.

| Requirement                       | Original evidence                                                           | Corrected test-only behavior                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1 — provider exception redaction | D-X1: raw import-provider error, including injected secret marker, escapes. | Catch import exceptions and create a fresh `EvidenceKeyringError('KEYRING_IMPORT_FAILED')`, with no original message, cause, logs or private payload. This new test-copy error code does not define HTTP/retry policy.                                                |
| E2 — owned raw-byte cleanup       | D-X2: failed import leaves decoded bytes uncleared.                         | Put decoded-byte length/date validation and import inside `try/finally`; clear owned bytes on success, import failure or later validation rejection. Tests retain the exact buffer references for success/failure inspection.                                         |
| E3 — UTF-8 byte bound             | D-X3: character count underestimates multibyte input.                       | Count UTF-8 bytes with an early-exit UTF-16 scan, without allocating another encoded secret-content buffer. Existing default bound is unchanged. Test ASCII, accents, CJK, astral characters and unpaired-surrogate replacement behavior against TextEncoder lengths. |
| E4 — finite positive bound        | D-X4: NaN/infinity disable the supplied bound.                              | Reject NaN, positive/negative infinity, zero and negative values with stable `KEYRING_SCHEMA` before import. No arbitrary new maximum or unrestricted fallback.                                                                                                       |
| E5 — valid/snapshotted clock      | D-X5: caller Date mutation during import changes evaluation.                | Validate once and capture the numeric verification instant before any await. Validate lookup clocks too; selection reads the captured/private numeric dates. Invalid clocks fail closed.                                                                              |
| E6 — immutable public metadata    | D-M1: public entry mutation changes selection.                              | Freeze the returned object, collection and entries. Retain private numeric time bounds and expose fresh Date copies through getters. Protect the returned genuine CryptoKey's visible metadata/handle from accidental mutation. No global cache.                      |

`KEYRING_SCHEMA` is reused for invalid clock/limit input; `KEYRING_IMPORT_FAILED` is stable and nonsensitive. Neither code approves a capture acknowledgement, HTTP response, retry class or live operational behavior. Cleanup is best effort for owned byte buffers only: immutable JSON/base64 strings, provider/engine copies, backups and runtime compromise are not erased or certified. Non-extractability/frozen metadata are not protection against a compromised runtime.

The candidate's configuration schema v1, exact cohort/version tuple, AES-256-GCM import algorithm/usages, default byte bound, eight-entry count and existing UTC monthly/runway rules remain unchanged for compatibility testing. No production custody, cohort/retention definition, escrow, destruction, key-cache policy or canonical identity is chosen or approved.

## Original-versus-corrected execution

The original fixture was not edited. For a local red-control run, its bytes were temporarily loaded only into the corrected evaluation path, running `keyring-review.test.ts --testNamePattern E[1-6]`; the corrected file was restored in `finally`. All **seven primary controls failed against original behavior**, with the remaining 35 tests filtered out. This intentional nonzero control result is evidence, not a failing final verification or skipped security coverage.

Restoring the corrected copy yields all **42 Block D compatibility/review cases as ordinary passes**, plus **13 added Block E cases**. These exercise success/failure buffer cleanup, code/stack/cause/log redaction, independent source pinning, byte boundaries, invalid limits/clocks, collection/entry/key metadata mutation, defensive Date copies and unchanged wrapping/rewrapping/decryption behavior. There are no expected-failure markers or skipped tests in the final focused run.

## Verification actually executed

- Focused Block D/E + C + B: **146 passed** (42 + 13 + 56 + 35).
- Full local API unit suite: **812 passed across 62 files**, zero expected failures.
- API source/test typechecks, focused ESLint, authored-file formatting, migration drift and diff checks passed. The original pinned source is deliberately not reformatted.
- Fresh disposable PostgreSQL **16.15**: unchanged Block A14 + envelope storage1, **15 passed**. All 46 unchanged SQL migration hashes matched; existing 44-check storage verifier and three-client lock/isolation/rollback verifier passed. Five economic denial triggers remained enabled during these checks. Container removed afterward.
- Final GitHub CI outcome and exact published SHA are recorded in the PR. Existing isolated baseline award fixtures remain unchanged; they are not keyring or economic authorization.

The disposable SQL role is owner/superuser/BYPASSRLS, not evidence of production RLS/tenant isolation. No production/staging role or database is inspected or changed. Synthetic keys are confined to test runs. Static tests exclude both original and corrected fixture names from non-test application source; there is no runtime export, deployed webhook call, network request or database operation introduced by the corrected loader.

## Compatibility and remaining boundaries

Reviewed candidate/pinned keyring sources, Block B signatures, Block C envelope, Block D findings, 0045/schema and HETA-01B–01G. Original Revision 3.3/H1–H20 remain unavailable. The scoped defects are corrected only in the evaluation copy; original provenance is preserved and runtime adoption remains blocked.

No non-test application code, SDK, workflow, configuration, lockfile, migrations 0040–0045, role/RLS, secret, Hyperdrive binding, Stripe configuration, existing webhook, durable capture or financial functionality changes. Global identity, business-isolated loyalty, branch permissions, Community Points, Split 06 settlement, Split 07 Partner Credits, Split 08 invoice authority, append-only histories and all five financial guards remain intact. `historicalTierVerified=false`, `issuanceAuthorized=false`, `redemptionAuthorized=false` remain denied wherever defined.

**Verdict:** PASS for E1–E6 in the isolated corrected test copy, subject to the PR's recorded CI result; BLOCKED for production adoption and full HETA acceptance. PR #146 remains a dependency until separately resolved. No source recovery, custody/retention, authoritative persistent initialization, provider identity/completeness or key destruction certification is claimed.

**Stop after Block E.** No merge/deploy, capture activation or automatic Block F. Recommend independent review of the corrected artifact and dependency first; any next block requires explicit owner authorization. No independent approval is claimed here.
