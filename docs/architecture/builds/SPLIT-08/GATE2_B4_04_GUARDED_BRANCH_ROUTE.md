# Gate 2 B4-04 — Guarded Nonfinancial Branch Route Integration

**2026-11-09. DEVELOPMENT ONLY.** No merge, deploy, database write, Neon role, credential, Hyperdrive edit, migration or financial activation.

## Baseline and independently verified prerequisites

- Development branch from `main` `19c489ef1db977abc10fa5186ac183c135bcc816`.
- PR #323 (B4-01), #324 (B4-02), #325 (B4-03) remain separate unmerged branches at preparation time; none of their files was merged or copied onto main.
- #323 exposes an unmounted TypeScript broker-read adapter using a 13-argument HMAC-style signature.
- #324 proves a disposable HMAC restricted-login SQL function called `gate2_b4_02.read_one_branch`; it is not installed anywhere live.
- #325 implements an unmounted Ed25519 assertion issuer; it cannot be silently used as input to the HMAC-style #323/#324 broker. No trusted production issuer custody or asymmetric database verifier is certified.
- Existing `branch.routes.ts` authenticates staff, resolves tenant membership, requires `branches:view`, enforces permitted branch route parameter and reads through the existing BranchService. Production and staging Hyperdrive currently use `neondb_owner` with BYPASSRLS; the protected restricted role is not provisioned.

## Implemented safe scope

1. Add an explicit `selectB4BranchReadPath` branch-read selection seam. It selects **`existing-route`** by default and rejects any attempt to choose the proposed `broker` path with a deterministic **503 B4_BROKER_NOT_CERTIFIED**. It does not use environment flags, headers, query parameters, secrets or database state.
2. Invoke the seam inside the existing authenticated and permission-protected `GET /branches/:id` handler before the existing DB open. The legacy route still executes unchanged when selected. No additional endpoint or public authorization surface is added.
3. Unit tests cover default behavior, broker activation denial, unsupported modes, request/env-based activation absence, and retention of existing authenticate/tenant/permission/branch guards. These tests confirm a dormant seam—not production broker authorization.
4. Do not add database migrations, SQL functions, provider/settlement capabilities or secrets. No Hyperdrive connection change.

## Nonnegotiable B4-04 activation blockers

- Independently reconcile a single **versioned assertion format**, canonical encoding, issuer/audience, operation code, public key signature algorithm, key ID and request/nonce/session bindings across #323–#325.
- Provide a database-verifiable issuer chain with durable issuer authority, separate signer custody, reliable key publication/rotation and fail-closed revocation.
- Confirm the exact persisted session, business membership, branch ownership and `branches:view` authorization at issuance **and** at time of operation, without trusting mutable HTTP headers or GUCs.
- Prove nonce replay and revocation concurrency in one operation against a restricted, nonowner login without arbitrary business-table CRUD or owner membership.
- Prove a real nonfinancial read through a safely isolated test Worker/Hyperdrive configuration, with pooled-connection tenant switching, negative cross-tenant tests, log-safety checks, and rollback.
- Owner authorization required separately before introducing any production/staging runtime credential or activating the route. No automatic advancement to B5 or migration.

**Verdict:** guarded route selection seam development complete, active broker certification blocked. Only exact-head CI and independent owner review can establish merge readiness; a green CI does not authorize deployment.
