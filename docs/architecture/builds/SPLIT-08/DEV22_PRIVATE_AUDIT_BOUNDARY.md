# ECHO GRID — DEV-22 Trusted Private Provenance Audit Boundary

Status: development-only; merge and deployment prohibited pending exact-head verification and owner review.

## Baseline
DEV-21 PR #245 merged to main as `11a2675a79503736594155f1caa282ab7fbe9300`. DEV-21 verifies persisted links cryptographically but documents that the calling composition root must independently authorize the tenant and audit workload. DEV-22 addresses only that private boundary.

## Implementation
- Add `private-provenance-audit-stage.ts` as an inert internal-only wrapper around DEV-21's existing private verifier.
- Resolve a dedicated `PROVENANCE_AUDITOR` workload record from trusted, injected configuration, with explicit development environment, bounded business allowlist, validity window, and revocation state.
- Fail closed on malformed, unavailable, expired, revoked or cross-tenant configuration. Re-read trusted configuration after cryptographic verification before returning a successful verdict.
- Require an issued genuine custody reader; do not allow a fabricated capability or a caller-supplied identity to assert trust.
- A distinct dedicated auditor database connection must already have authorization under existing PostgreSQL forced RLS. This module creates no DB role, grant, credential, migration, or route.
- All verdicts preserve `financialAuthorization: 'NOT_GRANTED'`. No D4 consumer, R10 recovery, provider call, Stripe state, balance, or ledger mutation.
- The unprovisioned workload source is the explicit default-deny entrypoint. Configuring a real workload is a separate owner-controlled operational action, not performed in DEV-22.

## Tests / gates
- Unit: disabled source, forged custody reader, malformed ID; no DB invocation on deny.
- Disposable PostgreSQL: real signed custody and recorder evidence, tenant-bound audit verification, tenant mismatch, runtime revocation, financial state unchanged.
- Preserve DEV-21 full regression and hosted exact-head CI. Report unique versus overlapping test counts honestly.

## Limitations and merge gate
- Do not expose the private stage to any HTTP route, queue, timer, service consumer or production credential without separate approval.
- The configuration source must be provided by a trusted composition root; passing arbitrary sources to this library from public input would violate the boundary.
- The audit principal is distinct from ordinary application and recorder logins and is not provisioned here.
- Revocation revalidation is an acceptance-time check, not an atomic distributed transaction with PostgreSQL.
- Development completion does not authorize financial activation. Owner review and independent security approval remain separate.
