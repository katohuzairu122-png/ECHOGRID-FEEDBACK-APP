# HETA-01-F1-D — Test-only keyring security and failure-handling review

**Date:** 2026-10-20. **Main baseline:** `a76dfe9cf5687a175803ee2cf3999f3e48e06366`.
**Dependency:** Block C PR #145 is merged; Blocks A/B/C remain unchanged.
**Scope decision:** use the expressly authorized test-only/characterization option. No runtime keyring is adopted or corrected in this block because the candidate combines key import with unapproved cohort/runway policy.

## Source and policy boundaries

Candidate `ccr-heta01-f1-impl1` remains at `86f709d62891a396fa040c14783faae6526e8a5c`. Reviewed its `keyring.ts`, current reviewed `envelope.ts` and signature helpers/tests, Block A, migration 0045 and evidence schema, HETA-01B–01G and available design references. The original Revision 3.3/H1–H20 are still unavailable. No original design checksum or decision approval is claimed.

The unchanged candidate keyring is pinned under `apps/api/test/fixtures/`, accompanied by a source manifest. Original Git blob: `3755bc8ae519e2396b1cdbfef3a54b19e2be2fea`. Source SHA-256: `145620753b3f10c57fbaacfb805f7f54fd695862c7d1c3b5d5c9de8468c5a8c3`. A test verifies that source hash, allowing only Git-checkout CRLF normalization back to upstream LF. This is a code provenance hash, not the missing Revision 3.3 document hash.

The candidate's JSON v1, cohort/version tuple, monthly selection, eight-entry limit and next-month runway are characterized only. They are not adopted as approved key identity, retention, custody, cache, rotation or destruction policy. The fixture's original comments about capture/HTTP mapping are upstream commentary, not implemented or approved behavior. No public/runtime barrel export or deployment caller imports the fixture.

The loader imports KEKs supplied in synthetic configuration; it does not generate KEKs, persist/initialize authoritative DEKs, implement a shared process cache, reconcile provider identity or authorize a tier. Existing Block C functions generate/wrap synthetic DEKs in tests. Non-extractable keys do not prevent runtime compromise or prove erasure of original JSON/base64 strings, backups or engine copies.

## Findings and expected-failure accounting

The review adds **42 cases: 36 ordinary passing tests and six explicit `it.fails` controls**. Expected-failure tests execute the unmet assertion against the pinned source; Vitest reports a successful run only while those assertions fail as expected. They are not skipped tests and are NOT remediated security passes. A future candidate correction must revise the fixture/manifest and finding disposition deliberately.

| Control | Reproduced behavior                                                                                                    | Disposition                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| D-X1    | `crypto.subtle.importKey` exceptions propagate unchanged, including an injected synthetic private marker.              | Expected failure: candidate does not provide code-only provider-error redaction. No HTTP/capture caller is introduced.                       |
| D-X2    | Decoded raw key bytes remain nonzero after an import-provider failure; cleanup runs only after successful import.      | Expected failure: failure-path cleanup incomplete. No certified key destruction/erasure claim.                                               |
| D-X3    | `maxBytes` compares JavaScript character length, permitting a UTF-8 configuration larger than its declared byte bound. | Expected failure: byte-versus-character limit mismatch. No new size policy is chosen.                                                        |
| D-X4    | NaN and positive infinity bypass the supplied bound.                                                                   | Two expected-failure cases for non-finite limit validation.                                                                                  |
| D-X5    | Caller mutation of the supplied Date during asynchronous import changes the load-time cohort/runway evaluation.        | Expected failure: no verification-time snapshot.                                                                                             |
| D-M1    | Exposed entry objects remain mutable; changing `active` changes later selection.                                       | Passing characterization of a mutable-state risk. Immutability/cache ownership expectations need review; no policy-changing fix is invented. |

No runtime keyring fix is claimed. Missing design/policy boundaries prevent safe adoption of the whole candidate loader. This block records actionable defects and tests rather than smuggling those policies into application code. Generic provider-error classification/retry behavior and eventual key-cache ownership require a separately scoped implementation decision.

## D2 execution matrix

| Requested scenario              | Actual execution and limit                                                                                                                                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Generation/retrieval         | Imports synthetic non-extractable AES-256 KEK; existing envelope primitive generates, wraps, restores and uses a synthetic DEK. No real KEK provisioning.                                                                              |
| 2. Missing KEK                  | Missing configuration rejects; unavailable exact cohort/version lookup returns undefined without fallback.                                                                                                                             |
| 3. Incorrect KEK                | Wrong synthetic KEK cannot unwrap.                                                                                                                                                                                                     |
| 4. Invalid length               | 16/64-byte configured keys reject.                                                                                                                                                                                                     |
| 5. Unsupported algorithm        | AES-128-GCM and RSA-OAEP configurations reject; no downgrade.                                                                                                                                                                          |
| 6. Invalid usage                | Decrypt-only wrapping/new-key configuration and encrypt-only unwrapping reject through reviewed envelope operations. This is operation compatibility, not a production key-permission policy.                                          |
| 7. Corrupted wrapped DEK        | Altered wrapped bytes reject.                                                                                                                                                                                                          |
| 8. Wrong cohort                 | Wrong envelope wrapping cohort rejects.                                                                                                                                                                                                |
| 9. Wrong version                | Wrong wrapping version rejects; missing lookup has no implicit replacement.                                                                                                                                                            |
| 10. Wrong fingerprint           | Changed fingerprint rejects.                                                                                                                                                                                                           |
| 11. Concurrent initialization   | Eight simultaneous loads yield independent import arrays/CryptoKey objects and interoperable KEKs. No shared cache is poisoned. **Not authoritative database DEK initialization/concurrency proof; that service does not exist here.** |
| 12. Duplicate version           | Duplicate cohort/version tuple rejects; same label in distinct cohorts remains separate. No canonical-identity change.                                                                                                                 |
| 13. Rotation                    | Synthetic retained-old/active-new configuration supports verified rewrap/read-back. No real rotation, old-key removal or custody procedure.                                                                                            |
| 14. Same DEK after rewrap       | Fingerprint and payload ciphertext remain unchanged; restored DEK opens the original payload using its original binding.                                                                                                               |
| 15. Incorrect old KEK           | Rewrap rejects.                                                                                                                                                                                                                        |
| 16. Incorrect new configuration | Weak/decrypt-only new keys reject without returning replacement material.                                                                                                                                                              |
| 17. Temporary failure recovery  | A subsequent independent load succeeds after a single provider failure. Exception redaction remains D-X1.                                                                                                                              |
| 18. Permanent unavailability    | Repeated missing-key lookup does not synthesize, substitute or weaken a key.                                                                                                                                                           |
| 19. Cache/cohort isolation      | Cohorts and independent loaded configurations do not share imported key objects/material by label. There is no approved production cache or cache-invalidation contract.                                                               |
| 20. No plaintext-key disclosure | Successful paths return CryptoKeys/wrapped bytes; raw-key export rejects. Failure cleanup remains D-X2; runtime compromise is not prevented by non-extractability.                                                                     |
| 21. Private exception markers   | Injection reproduces D-X1; not reported as a passing security control.                                                                                                                                                                 |
| 22. Logs/redaction              | Console spies see no normal validation/load logs; controlled validation errors exclude serialized configuration. Provider exception redaction remains blocked.                                                                         |
| 23. Envelope compatibility      | Candidate-imported synthetic KEKs interoperate with unchanged reviewed Block C wrapping/envelope functions. Rebinding payload key-version metadata without re-encryption rejects.                                                      |
| 24. No network/DB changes       | New keyring tests invoke no network/database operation; fixture has no imports or DB/network dependencies. Existing A/C SQL tests run separately on disposable PostgreSQL only.                                                        |
| 25. No financial authority      | No runtime/application authorization change. Existing denied authority contracts, migrations and guard verifiers remain unchanged. Key availability is not historical-tier authority.                                                  |

## Verification evidence

- Focused A/B-independent crypto review: **133 cases completed** (42 new, 56 unchanged envelope, 35 unchanged signature), including the six expected failures above.
- Full local API unit run: **799 cases across 61 files**, including those same six expected failures. No additional unexpected failure.
- API source/test typechecks passed after correcting a test-only Node/Workers URL-type mismatch. Focused ESLint passed. Authored tests/manifest/report are formatted; the verbatim candidate fixture is deliberately not reformatted so its pinned hash remains valid.
- Local disposable PostgreSQL **16.15**: unchanged Block A14 + envelope storage1, **15 passed**. All 46 unchanged SQL migration hashes matched; existing 44-check evidence-storage and three-client lock/isolation/rollback verifiers passed. All five economic denial triggers remained enabled during these checks. Container removed afterward.
- Migration drift check passed. Final diff/import-boundary checks and GitHub CI are recorded in the PR against the published SHA. No staging/production database or live role was inspected.

The disposable database role was owner/superuser/BYPASSRLS as reported by unchanged Block A. Results do not prove production role/RLS isolation. Existing CI's separately isolated provisional-award fixtures are unchanged and do not grant keyring or economic authorization.

## Preserved architecture and disposition

Only tests, a pinned source fixture/manifest and this report change. No non-test application code, schema, migration, workflow, SDK, lockfile, role, RLS, secret, Hyperdrive, Stripe account or deployed webhook change. No real keys, durable capture, production rotation/destruction, financial writes or trigger disabling by the new tests/local verifiers.

Global identity, business-isolated loyalty, branch permissions, Community Points, Split 06 consent/acceptance/fulfillment/reversal, Split 07 Partner Credits, Split 08 billing authority, PC-ECON/1 and append-only economic histories are unchanged. Migrations 0040–0045 remain unchanged. `historicalTierVerified=false`, `issuanceAuthorized=false`, `redemptionAuthorized=false` remain denied wherever defined.

**VERIFIED:** bounded synthetic review results and reproduced candidate gaps. **IMPLEMENTABLE:** test-only evidence recorded here. **BLOCKED:** runtime keyring adoption, unresolved controls, original design/H1–H20, custody/cohort/identity/cache decisions and authoritative persistent initialization. **DEFERRED:** capture, F2/F3, economic enablement and destruction certification.

**Verdict:** PASS for the authorized test-only Block D review; BLOCKED for keyring adoption/hardening acceptance. Stop after Block D. No automatic Block E, merge or deployment. Recommend independent review of these findings, then a separately authorized policy-independent key-import/redaction correction proposal with explicit decisions on its interface and error handling. Await independent ChatGPT review and owner authorization.
