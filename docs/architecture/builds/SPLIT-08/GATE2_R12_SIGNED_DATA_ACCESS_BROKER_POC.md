# Gate 2 R12 — Signed, restricted database broker feasibility proof

**DEVELOPMENT ONLY / DISPOSABLE POSTGRESQL 18. NO PROD/STAGING IMPLEMENTATION AUTHORIZED.**

## Baseline
Authoritative main at branch creation: `ae9026e5bcf43d05e2bd733f3b98fc02b8824d55`. R10 and R11 are merged and passed seven exact-head CI workflows. Actual Cloudflare staging Hyperdrive remains connected as `neondb_owner`, which has BYPASSRLS. Staging was last inspected at 45/67 migrations with no public-table RLS.

## Purpose
R10 proved a tenant-scoping custom PostgreSQL GUC is spoofable by a shared login. R11 proved per-tenant authenticated PostgreSQL `session_user` mapping, but cannot be adopted unchanged with Echo Grid's single shared Hyperdrive credential. R12 explores a restricted broker accessed by a shared nonowner database login **without direct access to any tenant table**.

## Disposable test design
- A GitHub Actions PostgreSQL 18 container is created and the committed 67 migrations are replayed. All subsequent schema/role/key/fixture changes occur **only in that container**; no migration file is added.
- Two synthetic businesses with branches are created. The test-only owner creates a private schema containing a 256-bit random HMAC verification key, explicit actor-to-business memberships and a consumed-nonce registry. These are not accessible to the caller.
- A tightly scoped `SECURITY DEFINER` function, with fixed `search_path`, exposes one operation: **read branch identifiers/names for the authenticated business**. It never accepts arbitrary SQL or returns other tenant data.
- An independent simulated issuer signs `version | actor | business | operation | nonce | expiry`. The database independently verifies the HMAC, checks expiry <=120 seconds, matches the owner-controlled membership, atomically consumes the nonce, and returns only matching rows.
- The shared-style nonowner login receives only EXECUTE on this function plus schema USAGE, not direct CRUD/table grants. The test verifies own-business readings, signature tampering denial, action mismatch, expiry, replay, nonexistent membership, forged custom GUC and arbitrary SQL/verification-key reads denied.

## Security and architecture limitations
1. The issuer is **simulated inside disposable CI**. No trustworthy issuance path, signer's credential custody, credential rotation, key distribution, replay storage retention, authentication revocation, account compromise defense, abuse rate limits or breach response has been developed. A compromised authorized issuer could generate valid assertions.
2. This proves a single **read-only branch-list operation**, not general staff/public/customer/QR/feedback/loyalty access. Each action requires separately reviewed contracts and business/branch permissions.
3. HMAC verification is not guaranteed constant-time; review a production-grade verifier for timing attacks. PostgreSQL SECURITY DEFINER and extension schema privileges require independent audit.
4. Used nonces are stored durably until separately cleaned up; a validated expiry-aware, bounded cleanup policy is required. Repeat calls are refused intentionally; logical transactions and retry semantics need design.
5. Application Worker authorization must be verified before issuance; proof issuance may require a separate isolated service. Headers, runtime GUCs or unsigned tenant identifiers are never sufficient alone.
6. This does not replace existing settlement/evidence guards or authorize Partner Credit issuance, Stripe, settlement actions, staging migration, Hyperdrive cutover or customer onboarding.
7. Compatibility of operation-specific signed assertions with the existing shared Hyperdrive pooled connection, backend call graph and performance must be independently verified. A green CI exercise is **NOT** runtime or launch readiness.

## Gate decision
A passing R12 test demonstrates **bounded, non-forgeable within the test's signing-key trust boundary** access to synthetic branch data and replay denial. It does **not** certify a deployable broker or application role. Owner must separately approve trust architecture and use-case coverage. Gate 2 remains **BLOCKED**.

No automatic merge, deploy, live Cloudflare/Neon changes, persistent credentials, or financial activation.
