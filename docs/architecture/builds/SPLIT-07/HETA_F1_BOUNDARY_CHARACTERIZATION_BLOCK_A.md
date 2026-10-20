# HETA F1 recovery — Block A: evidence-storage boundary characterization

**Date:** 2026-10-20. **Baseline:** main `23fe4a2bb67a8c1a3e126b0dc0f506243d76cc11`.
**Scope:** tests and documentation only. No application, schema, migration, workflow, secret, role or deployment changes.
**Verdict:** PASS for the bounded characterization block; capture integration and full F1 acceptance remain BLOCKED.

## Investigation and source recovery

At inspection, PR #140 (0045 schema) and #141 (44 storage assertions and certification count repair) are merged. PR #142 is an open draft with passing CI at `dca1aee7989d167af685bd1a217ab4b50baa54e8`; its source-gap register is not merged or an approved design. Candidate branch `ccr-heta01-f1-impl1` remains at `86f709d62891a396fa040c14783faae6526e8a5c`, with unmerged catalog and cryptographic-module work. No candidate files are imported here. There is no remote branch named exactly `staging`.

Main/candidate trees, available Git history, relevant PRs/issues, a repository commit search for `HETA-01-F1-design.md`, and relevant local project/attachment filenames and text searches did not recover original Revision 3/3.1/3.2/3.3 text or H1–H20 prompts/owner decisions. This bounded search is not proof that no external source exists. The candidate JSON's `designRevision: "3.3"` is a catalog label, not the missing full design.

PR #140 reports design SHA-256 `e46680c26de8a1db237408b375be983925d37b100798edacea9cb802feda7b35`. No original source bytes were available to verify it. No document has been reconstructed or certified as that original. H-number meanings and owner approvals remain unknown.

## Work partition

| Category      | Disposition                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VERIFIED      | Main contains migration 0045's six evidence tables; HETA-01B separates authentic capture from tenant binding/projection and financial authority; HETA-01D/G deny unproved coverage and economic activation.                           |
| IMPLEMENTABLE | Test the existing SQL identity, scope, FK and catalog behavior using synthetic records and disposable PostgreSQL; document gaps without changing their contracts. This block implements only that work.                               |
| BLOCKED       | Exact Revision 3.3/H1–H20 recovery; cross-provenance canonical reconciliation; malformed-context retention policy/schema; semantic attestation verification; real-role/RLS design; capture transaction/ack and key-custody decisions. |
| DEFERRED      | Candidate cryptographic hardening, production webhook integration, F2 verified identity binding, F3 safe projection, historical completeness/certification and separately authorized economic enablement.                             |

## Authoritative requirements and test mapping

References: [HETA-01B](HETA_01B_IMMUTABLE_SUBSCRIPTION_IDENTITY_AND_PROVIDER_EVENT_CAPTURE_CONTRACT.md), [HETA-01D](HETA_01D_HISTORICAL_SUBSCRIPTION_INTERVAL_COMPLETENESS_AND_CERTIFICATION_DESIGN.md), [HETA-01G](HETA_01G_INDEPENDENT_ARCHITECTURE_SECURITY_ECONOMIC_ACCEPTANCE_GATE.md), migration `apps/api/drizzle/0045_heta01_f1_stripe_evidence.sql` and `apps/api/src/db/schema/stripe-evidence.ts` at the baseline above.

The new `apps/api/test/integration/stripe-evidence-boundaries.integration.test.ts` runs in the existing serial integration tier. Eight cases verify enforced SQL properties; six explicitly characterize unresolved semantic gaps. Characterization expectations describe current behavior, not desired authorization. A later approved correction should deliberately change those cases and the recorded disposition; do not keep an unsafe behavior merely to preserve these expectations.

| Coverage                           | Actual assertion                                                                                                                                      | Meaning and limit                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Same SQL identity replay           | Same provenance/account/mode/event replay gets unique violation; one original row remains.                                                            | Storage constraint only; no application idempotent acknowledgement is implemented.                                                      |
| Same-provenance conflicting digest | Unique violation; original digest retained; no conflict record automatically appears.                                                                 | No silent overwrite; durable conflict capture/recovery is still absent.                                                                 |
| Account/mode scoping               | Separate mode, direct receiving account and connected event-account tuples can coexist. Direct scope with mismatched accounts rejects.                | Storage separation, not tenant authorization or account attestation. Synthetic `livemode=true` rows do not contact live Stripe.         |
| Attestation FK                     | Nonexistent reference rejects.                                                                                                                        | Existence check only.                                                                                                                   |
| Financial guard catalog            | All five existing financial denial triggers remain enabled.                                                                                           | Introspection, not a new positive financial test.                                                                                       |
| R1 provenance gap                  | Contradictory webhook/API digests coexist under the same logical provider identity, with no automatic conflict row.                                   | Canonical authority cannot be inferred from the unique index; integration remains blocked.                                              |
| R2 malformed-context gap           | Same malformed digest under a different receiver/verification label rejects at the global digest index; only the first context remains in that table. | No approved merge/discard behavior is established. Any correction needs a separately reviewed additive proposal, not a rewrite of 0045. |
| R3 attestation semantics           | Failed attestations, wrong control-event kind, and synthetic mismatched account/mode/expired detail probes are accepted by the FK.                    | SQL does not verify attestation meaning. Probe JSON keys are not a proposed new attestation contract.                                   |
| R4 RLS/capabilities                | Six evidence tables have no row-security/forced-row-security policies. Disposable test-role capability booleans are logged.                           | No claim of database-enforced tenant isolation, actual production-role inspection or permission to change roles.                        |

## Verification and environment

Local fresh Docker PostgreSQL **16.15**, loopback-only port 55447, synthetic user/database; no persistent volume or production/staging connection. Applied all 46 unchanged migrations. Existing exact migration verifier matched all 46 SQL hashes. The 14 new integration tests passed, including per-test rollback checks for control/key fixtures. The existing 44-check storage verifier and existing three-client lock/isolation/rollback verifier passed. Test-only identity sequences can advance despite rollback; the entire container is disposable and removed afterward.

The local test role was superuser, BYPASSRLS and evidence-table owner. Its successful inserts are NOT evidence of least-privilege runtime access or cross-tenant RLS. No production role, Hyperdrive binding or database setting was inspected or changed.

The initial local typecheck could not resolve shared workspace dependencies in the new worktree. Reusing the existing installed shared-types dependency directory corrected the environment without changing manifests or lockfiles. Final API source/test typechecking, focused ESLint, formatting and diff verification passed; actual CI results are recorded in the PR.

No trigger is disabled, no financial row is inserted and no Stripe API is called by the new tests or this block's local verification commands. Existing repository CI includes its separately isolated provisional-award fixture suite; it is unchanged by this PR and is not counted as new capture authorization. PG18, provider integration, cryptographic execution, actual application RBAC/RLS, capture concurrency/failure recovery and original T01–T44 acceptance are not claimed by these 14 tests or the earlier 44 assertions. Browser tests, if present in baseline CI, exercise existing product flows rather than an evidence-module UI.

## Compatibility and stop boundary

All changes are additive test/documentation files. Existing billing signature verification, legacy subscription projection, migration-0043 observations, candidate module interfaces, global customer identity, business loyalty, branch RBAC and Community Points are unchanged. Split 06 remains authoritative for consent/acceptance/fulfillment/reversal. Split 07/08 ownership, PC-ECON/1 and approved policy boundaries remain intact. Migrations 0040–0044 and their hashes are unchanged; no migration is generated or edited.

`historicalTierVerified=false`, `issuanceAuthorized=false`, `redemptionAuthorized=false` remain the required denied states. No new path can return authority, issue/redeem Partner Credits, apply Stripe discounts or connect candidate capture to a webhook. Green tests characterize storage and do not close HETA-01G or grant owner approval.

**Next recommended independently safe block, requiring a new go-ahead:** selectively review the candidate's standalone envelope/keyring/signature/shape validation and add synthetic failure/redaction tests without importing deployment wiring. Recover the source in parallel; any uncertain algorithm/AAD/custody/interface choice remains blocked. Stop after this Block A and await owner direction; do not auto-advance or merge.
