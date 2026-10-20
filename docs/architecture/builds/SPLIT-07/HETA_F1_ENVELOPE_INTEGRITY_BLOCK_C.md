# HETA-01-F1-C — Standalone envelope integrity and binding verification

**Date:** 2026-10-20. **Baseline main:** `33e097d73c040691083f813a42a18dbf3e94ff90`.
**Candidate:** `ccr-heta01-f1-impl1` at `86f709d62891a396fa040c14783faae6526e8a5c`.
**Authorization:** standalone synthetic cryptographic tests and narrow non-activating corrections only.
**Disposition:** bounded integrity verification; NOT full F1, provider, tenant-binding or key-custody certification.

## Repository and source reconciliation

PR #144 is merged; main includes Block A's 14 storage tests and Block B's standalone signature helper/35 tests. PR #142 was closed without merging, so its reconciliation draft does not supply an approved design or decisions. HETA-01B–01G remain the applicable non-activating domain/evidence boundaries. Original Revision 3/3.1/3.2/3.3 and H1–H20 remain unavailable; PR #140's reported SHA-256 is not verified against original bytes.

Reviewed candidate envelope, keyring, signature, shape and tests; current 0045 SQL/schema; Block A/B; and the HETA-01B–01G gates. Only the candidate envelope primitive is selectively incorporated. No keyring loader, schema/catalog bundle, shape classifier, barrel export or production import is introduced.

## Proposed and implemented scope

Preserve the candidate's public functions, result/error variants, `heta01-f1/1` version, u32-big-endian length-prefixed UTF-8 AAD ordering, fingerprint domain, 12-byte nonces and 128-bit GCM tags. No new record-ID, account/mode serialization, key format, cohort definition, retention policy, database column or provider-provenance contract is invented. These bytes are compatibility with a candidate implementation, not approval of its missing full design.

Corrections validate AES-GCM 256-bit keys and required nonempty binding metadata, enforce the existing migration-0045 payload bound (1–16,777,216 bytes), reject malformed digest/nonce/ciphertext/wrapped-DEK shapes, snapshot mutable inputs before awaiting crypto, redact provider failures, and clear owned plaintext/raw-key buffers on failure where accessible. Public successful return shapes and valid envelope bytes remain compatible. Invalid-input behavior is deliberately stricter. Existing error variants are reused; their coarse classifications are not an approved production HTTP/retry contract.

The initial full-size byte-array equality assertion exhausted the local test runner's heap. The test was corrected to compare byte length and SHA-256 without changing the existing payload limit. A subsequent completed run of **54 tests against the unmodified candidate** produced **28 failing assertions and 26 passes**. This includes missing stable validation/error expectations and independently reproduced integrity gaps; it is not a count of 28 vulnerabilities. The final suite adds two more boundary/redaction cases and passes all **56** tests.

## Findings and correction rationale

| Finding                                   | Independent reproduction                                                                                                                                    | Narrow correction                                                                                                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Weak/wrong key class accepted             | Candidate seals/wraps with AES-128 despite its AES-256 contract; rewrap accepts a validly encrypted 16-byte DEK.                                            | Check AES-GCM key length/type and 48-byte wrapped-DEK shape; retain the 32-byte raw DEK invariant. No key provisioning/rotation policy is selected.                       |
| Missing storage-shape validation          | Candidate accepts authenticated 16-byte nonces that WebCrypto permits but 0045 rejects; oversized plaintext and empty binding fields can be sealed.         | Enforce existing 12-byte nonce, 32-byte digest, tag/size bounds and required metadata. No new cohort grammar or retention limit.                                          |
| Mutable inputs cross async boundaries     | Caller mutation between digest/encryption changes plaintext/binding; digest mutation during post-decrypt hashing can bypass the intended digest comparison. | Copy bytes/binding before awaiting; compare against a digest snapshot.                                                                                                    |
| Unredacted provider failures              | Encryption/wrapping/hash exceptions can escape as provider errors, including injected synthetic secret text.                                                | Return fresh stable `EvidenceCryptoError` instances without provider messages/causes; clear owned plaintext on digest failure. No logging is added.                       |
| Cryptographic identity is caller-supplied | Whole envelopes encrypted under the same caller-supplied identity string can be substituted and still decrypt.                                              | **BLOCKED semantic finding, no format change.** Test and document it; do not invent a record-ID field or claim a ciphertext proves authoritative tenant/account identity. |

JavaScript buffer clearing is best effort for directly owned buffers; it is not proof of erasure of engine copies, forensic media, backups or keys elsewhere. No crypto-shredding/destruction certification or operational rotation is performed. Extractability/custody policy for caller-provided keys remains outside this block; helper-generated/restored DEKs remain non-extractable.

## C2 adversarial verification matrix

| Requested case                     | Executed evidence and actual limit                                                                                                                                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Round-trip                      | Exact small plaintext round-trip; maximum existing payload-size boundary verified by length/digest.                                                                    |
| 2. Ciphertext tampering            | Changed ciphertext byte rejects.                                                                                                                                       |
| 3. Tag tampering                   | Changed trailing GCM-tag byte rejects.                                                                                                                                 |
| 4. Wrong key                       | Different AES-256 decryption key rejects.                                                                                                                              |
| 5. Wrong AAD                       | Changed table/cohort/key-version bytes reject.                                                                                                                         |
| 6. Wrong Stripe account            | Changed receiving/event-account bytes in a synthetic opaque identity reject; no provider account verification is implied.                                              |
| 7. Wrong operating mode            | Changed mode bytes in that identity reject; no live/test provider configuration is inspected.                                                                          |
| 8. Wrong event ID                  | Changed event-ID bytes reject.                                                                                                                                         |
| 9. Wrong digest                    | Both tampered authenticated metadata and a deliberately valid GCM fixture carrying an incorrect digest reject.                                                         |
| 10. Malformed envelope             | Null/non-byte ciphertext and malformed metadata reject with stable errors.                                                                                             |
| 11. Truncated/oversized ciphertext | Structural truncation and oversize reject before decryption; shortened authenticated ciphertext rejects its tag.                                                       |
| 12. Invalid nonce length           | 0/8/11/13/16-byte cases reject, including validly authenticated 16-byte-nonce ciphertext.                                                                              |
| 13. Wrong version                  | A direct WebCrypto fixture using different version bytes in AAD rejects. Version is a fixed module constant, not a new row-version parser.                             |
| 14. Missing metadata               | Empty/undefined table, identity, cohort and key-version binding fields reject.                                                                                         |
| 15. Record substitution            | Different binding rejects; identical-binding substitution is characterized as an unresolved identity-contract limitation.                                              |
| 16. No partial plaintext           | Authentication/digest failures reject; post-decrypt hash failure clears the directly owned buffer in an instrumented test.                                             |
| 17. Sensitive exceptions           | Injected provider errors become stable codes without original messages/causes.                                                                                         |
| 18. Accidental logging             | Console spies observe no logs in the encryption-failure path. No module logging exists.                                                                                |
| 19. Fresh nonces                   | Eight identical-plaintext samples have distinct nonce/ciphertext bytes; this sample is not proof of collision freedom or a lifetime nonce budget.                      |
| 20. Existing schema compatibility  | Real PostgreSQL stores generated wrapped-key/envelope bytes in unchanged 0045 tables, reads them back, unwraps/authenticates/decrypts, then confirms fixture rollback. |

Additional cases cover UTF-8 AAD golden bytes/field boundaries, fingerprint mismatch, wrong KEK/cohort/version, non-extractable restored keys, synthetic same-DEK rewrap compatibility, no network requests and mutable-input races. Synthetic direct WebCrypto fixtures require their synthetic keys; no ability to forge provider evidence without a key is claimed.

## Actual verification and limits

- Local focused tests: 56 envelope + 35 unchanged signature cases, **91 passed**.
- Local API unit suite: **757 passed across 60 files**.
- Local real PostgreSQL 16.15: 14 unchanged Block A tests + 1 new encrypted storage test, **15 passed**.
- Fresh loopback-only Docker database: 46 unchanged migrations applied; all 46 exact SQL hashes matched. Existing 44-check evidence-storage verifier and three-client lock/isolation/rollback verifier passed; all five financial denial triggers remained enabled during these checks. Container removed afterward.
- Migration drift check, API source/test typechecks, focused ESLint, formatting and diff checks passed; actual final CI evidence is recorded in the PR.

The disposable SQL role is owner/superuser/BYPASSRLS, as logged by unchanged Block A; this is not real-role tenant-isolation proof. The integration fixture's control-event result and account/event fields are synthetic data, not a provider attestation. No live credentials, provider API, actual account configuration, production/staging database, role grants, secrets or Hyperdrive binding is used or changed.

The new code is referenced only by unit/integration tests. No deployed Stripe webhook, capture, projection, tenant-facing evidence API or financial path imports it. No schema/configuration/workflow/SDK/lockfile change, migration generation, production operation or financial write is part of this block. Existing separately isolated provisional-award CI fixtures are unchanged and are not new envelope authorization.

## Remaining gates and stop boundary

**VERIFIED:** candidate-format authentication behavior, input/error corrections, byte compatibility and synthetic SQL round-trip. **IMPLEMENTABLE:** this standalone primitive/test block only. **BLOCKED:** original design/H1–H20, canonical identity construction and unique record binding, immutable provider attribution, key-custody/retention, attestation semantics, real-role/RLS and capture transaction/ack decisions. **DEFERRED:** keyring integration, F2/F3, complete historical coverage/effective-time authority and economic enablement.

Preserve global customer identity, business-isolated loyalty, branch RBAC, Community Points, Split 06 consent/acceptance/fulfillment/reversal, Split 07 Partner Credits, Split 08 invoice authority, append-only economic histories, PC-ECON/1 and all five economic guards. Migrations 0040–0045 and their recorded hashes are unchanged. `historicalTierVerified=false`, `issuanceAuthorized=false`, `redemptionAuthorized=false` remain denied wherever defined.

**Stop after Block C.** No merge/deployment, operational capture, real-key provisioning, financial activation or automatic Block D. Recommend a separately authorized decision/source-recovery review of canonical identity construction and record substitution before any integration. Independent architecture/security/economic approval is not claimed; await independent ChatGPT review.
