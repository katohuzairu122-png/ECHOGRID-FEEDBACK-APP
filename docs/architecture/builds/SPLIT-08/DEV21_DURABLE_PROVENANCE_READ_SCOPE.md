# DEV-21 — restricted durable provenance read (development-only design gate)

Status: IMPLEMENTATION NOT VERIFIED. This is a scoped architectural handoff, not financial authorization or release approval.
Baseline: main bf655f735a0c743f3856f4f44480a0cd861de27b (merged DEV-20.B PR #244).
No production access, activation, live Stripe, deployment, or automatic merge.

## Repository reconciliation

- Migration 0066 creates the immutable settlement_custody_authorization_links sidecar.
- The role settlement_authority_reader has SELECT under forced RLS, and settlement_auditor has an independent read policy.
- settlement_custody_link_matches is an exact-match SECURITY DEFINER boolean available to settlement_recorder only; it cannot be repurposed as a general read API.
- custody-authorization-provenance.ts is a pure proposed-link checker that explicitly returns durable:false. Do not change that to true without a persisted, independently verified link.
- The custody read performs current signature, workload, record-integrity and key-state checks, with independently durable verification audit events.
- DEV-20.B's recorder revalidates trusted custody immediately before persistence. External key revocation and PostgreSQL commit are not transactionally serialized.

## DEV-21 implementation boundary

Develop a private verification operation that accepts explicit businessId, reservationId, and authorizationId; it must never permit caller-selected tenant scope without trusted workload authorization. Resolve one persisted immutable link by exact tuple with a dedicated, narrowly authorized database read function. Do not use direct table SELECT from an ordinary app session, and do not grant broad table access.

The read function must be least-privilege, ownership-safe and default-deny. Distinguish no matching authorized link from infrastructure failure, but do not disclose cross-tenant existence. Do not weaken existing INSERT guards, immutable triggers, or RLS policies. If a new migration is required, use the next verified migration sequence and disposable PostgreSQL migration tests.

After reading the persisted tuple, retrieve custody through an issued trusted custody reader. Verify the current custody/workload/key state and compare the exact stored payload hash, key id/version, tenant and reservation. Read the authorization through the existing restricted authorization read facility, cross-check its exact ID and digest, recompute the digest, and independently verify the recorder Ed25519 signature. Do not trust a caller-constructed custody or authorization object.

Fail closed to a typed non-financial result: VERIFIED, UNLINKED, INVALID, or UNAVAILABLE; every result has financialAuthorization:'NOT_GRANTED'. VERIFIED must require all required checks; UNLINKED does not mean a legacy authorization is eligible, and no status affects the D4 consumer or R10 recovery authority.

## Required security verification

Test with disposable PostgreSQL as the actual restricted roles: tenant separation; ambiguous foreign/missing record handling; binding/digest/signature substitution; revoked and unavailable keys; SQL function EXECUTE rights and ownership; forced RLS; concurrent recorder/read transactions; no mutation of financial state; D4/R10 regression. Preserve original DEV-20.B tests.

## Execution gates

No implementation completion may be claimed until TypeScript checks, targeted tests, PostgreSQL integration, migration replay/drift checks, security regressions, and exact-head hosted CI are observed passing. A hosted CI success on this design-only commit is not evidence that the verifier has been implemented.

## Stop conditions

Stop for owner review on any conflict with previously approved Split 08 architecture, key-lifecycle policy, consumption authority, or migration ownership. Do not merge, deploy, activate financial operations, or start DEV-22.
