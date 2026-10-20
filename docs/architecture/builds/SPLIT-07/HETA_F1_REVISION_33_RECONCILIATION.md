# HETA-01-F1 Revision 3.3 — Source reconciliation and decision register

**Status: BLOCKED — source intake and baseline reconciliation only.**
**Reviewed main:** `23fe4a2bb67a8c1a3e126b0dc0f506243d76cc11`.
**Recorded:** 2026-10-20. Documentation only; no implementation or activation authorization.

## Source inventory

| Source                                                                                 | What is available                                                                                                                          | Authority and limits                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Merged PR #140](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/pull/140) | Describes the first schema block; names design Revision 3.3 and SHA-256 `e46680c26de8a1db237408b375be983925d37b100798edacea9cb802feda7b35` | Reported digest only; original document bytes are unavailable, so digest and contents are NOT verified. PR states owner decisions H1–H20 are not recorded. |
| Main, at the reviewed SHA                                                              | Six evidence tables, migration 0045, 46-entry journal and non-activating schema verifier from merged PR #141                               | Implemented storage baseline, not a reconstruction or approval of the missing design. No production migration state was inspected.                         |
| `ccr-heta01-f1-impl1` at `86f709d62891a396fa040c14783faae6526e8a5c`                    | New unmerged catalog contract, catalog integration test, envelope/keyring/signature/shape modules and unit tests                           | Source inspected as a candidate implementation. Not imported by this documentation change; no approval or test execution claimed here.                     |
| Candidate `docs/architecture/builds/SPLIT-07/stripe-evidence-contract.json`            | Declares `designRevision: "3.3"`; lists expected catalog                                                                                   | A derived catalog contract is not the complete design or owner decision list. It does not verify the reported design digest.                               |
| Requested `staging` branch                                                             | Remote-ref lookup and fetch found no branch named exactly `staging`                                                                        | Do not confuse a Cloudflare staging environment with a Git branch. Exact intended branch/path remains to be supplied.                                      |
| HETA-01B–01G documents on main                                                         | Capture, identity, boundaries, completeness, adversarial verification, migration readiness and acceptance-gate proposals                   | Preserve their non-activating boundaries. Merged documentation and green CI are not independent governance approval.                                       |

The available source search covered main, the current candidate implementation branch, PR #140's body/comments/reviews and relevant workspace/attachment filenames. PR #140 had no issue comments or submitted reviews at inspection. This does not establish that no external source exists.

## H1–H20 register

The original decision prompts are unavailable. IDs below are placeholders for source recovery, not invented questions, recommendations or owner decisions. Every row has status **SOURCE MISSING / UNDECIDED**, with no decision-maker, approval reference or approval date recorded. No topic is assigned to an H-number by inference from the code.

| Original ID | Original prompt/source | Recorded owner decision | Status  |
| ----------- | ---------------------- | ----------------------- | ------- |
| H1          | Not supplied           | None recorded           | Blocked |
| H2          | Not supplied           | None recorded           | Blocked |
| H3          | Not supplied           | None recorded           | Blocked |
| H4          | Not supplied           | None recorded           | Blocked |
| H5          | Not supplied           | None recorded           | Blocked |
| H6          | Not supplied           | None recorded           | Blocked |
| H7          | Not supplied           | None recorded           | Blocked |
| H8          | Not supplied           | None recorded           | Blocked |
| H9          | Not supplied           | None recorded           | Blocked |
| H10         | Not supplied           | None recorded           | Blocked |
| H11         | Not supplied           | None recorded           | Blocked |
| H12         | Not supplied           | None recorded           | Blocked |
| H13         | Not supplied           | None recorded           | Blocked |
| H14         | Not supplied           | None recorded           | Blocked |
| H15         | Not supplied           | None recorded           | Blocked |
| H16         | Not supplied           | None recorded           | Blocked |
| H17         | Not supplied           | None recorded           | Blocked |
| H18         | Not supplied           | None recorded           | Blocked |
| H19         | Not supplied           | None recorded           | Blocked |
| H20         | Not supplied           | None recorded           | Blocked |

## Reconciliation with implemented main

These findings use separate R-identifiers; they are not replacements for H1–H20.

| Finding                                     | Current evidence                                                                                                                                                                    | Required reconciliation                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 — Canonical event identity               | HETA-01B deduplicates by account + mode + event ID. `stripe_provider_events_identity_uq` additionally includes receiving/event accounts and provenance.                             | Define one logical canonical identity across webhook and API retrieval, including corroboration versus digest conflict. Schema uniqueness alone permits separate provenance rows and cannot establish cross-provenance idempotency. Do not silently change applied migration 0045.                            |
| R2 — Malformed receipt scope                | `stripe_provider_malformed_receipts_digest_uq` is globally keyed by payload digest.                                                                                                 | Review identical malformed payloads received in distinct account/verification contexts; determine how provenance is conserved without silently attributing evidence across scopes. Full Revision 3.3 intent is unknown.                                                                                       |
| R3 — Attestation references                 | Events and malformed receipts reference a control-event ID.                                                                                                                         | A foreign key proves existence, not a passed attestation, correct event kind, matching account/mode or validity window. Require an independently specified verifier/transaction contract.                                                                                                                     |
| R4 — Privacy and service authority          | Migration 0045 declares no RLS policies or grants/revokes; events retain encrypted payload fields and dispositions may carry a business ID.                                         | Specify actual database roles, restricted quarantine access, tenant-visible projections and negative isolation tests. Do not infer RLS or authoritative tenant binding from ciphertext or a business FK.                                                                                                      |
| R5 — Durable capture versus current billing | Existing webhook verifies a signature, processes the mutable subscription mirror, then records migration-0043 observations. It does not call the six-table evidence module on main. | Define commit/ack/failure behavior independently of attribution and safe projection. Metadata and current mirror cannot authorize historical tier. Preserve existing billing behavior until a separately reviewed integration.                                                                                |
| R6 — Cryptography and retention             | Main has storage fields/shape constraints, not a key-custody or cryptographic implementation. Candidate branch adds modules.                                                        | Reconcile algorithm, AAD, keyring, rotation, custody, access, retention/legal hold and failure semantics with authenticated source text and owner decisions. No real keys or raw provider payloads belong in the specification.                                                                               |
| R7 — Coverage and effective time            | No new runtime completeness certificate or authoritative effective-time chain is established by these tables.                                                                       | Preserve HETA-01C/D finite, nonoverlapping `[from,to)` proof requirements and append-only supersession. Missing/conflicting evidence denies authority; all logical states remain non-activating.                                                                                                              |
| R8 — Verification scope                     | PR #141 reports 44 PostgreSQL storage/rollback checks and green CI, using synthetic fixtures. Candidate branch separately names a catalog test T44.                                 | Do not equate 44 check assertions with T01–T44 acceptance. Trace each original test requirement to an actual test, SHA, environment and result after the original matrix is recovered. PG18, production roles, provider coverage and independent acceptance are not proved by the existing local PG16 result. |

## Required source intake and closure

1. Supply the complete original Revision 3.3 document and H1–H20 prompts, with author/source location and revision provenance. Store the source in a dedicated documentation-only change without private operational data.
2. Compute SHA-256 over the supplied original bytes before newline/encoding changes. Compare with the reported digest above. If a mismatch occurs, retain both receipts and request source/version resolution; never silently relabel another text as the hash-matched design. Record separate original and repository-rendered hashes if conversion is necessary.
3. Populate each H-row with its exact prompt/reference, explicit owner decision, decision-maker, date, approval reference, conditions, affected design sections/code/tests and unresolved alternatives. A broad request to reconcile documents is not an answer to twenty unavailable decisions.
4. Resolve R1–R8 against that source and the candidate branch. Accepted differences require explicit rationale and scope; immutable applied migrations require a separately reviewed additive correction if needed.
5. Record architecture/security/economic review findings against the exact reconciliation SHA. Do not claim a model assessment, merged PR or CI success is independent approval.
6. Only then scope the next implementation block; do not infer capture wiring, projection enablement, positive historical-tier verification or financial activation from this register.

## Preserved boundaries

Split 06 remains the sole authority for orphan-settlement fulfillment, customer consent, receiving-business acceptance and reversal facts. Split 07 owns earning; Split 08 owns invoice application and terminal redemption. Preserve global customer identity, tenant/branch RBAC, isolated business loyalty and Community Points, append-only economic histories, historical-tier proof and PC-ECON/2-A01 policy boundaries. Migrations 0041/0042/0044 are unchanged and must not be disabled or bypassed. `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain false wherever defined. No Stripe call, database change, application/configuration change, merge or deployment is performed by this documentation change.

**Disposition:** Baseline/source gaps recorded; exact Revision 3.3 and H1–H20 reconciliation remains incomplete until source intake and explicit decisions are recorded.
