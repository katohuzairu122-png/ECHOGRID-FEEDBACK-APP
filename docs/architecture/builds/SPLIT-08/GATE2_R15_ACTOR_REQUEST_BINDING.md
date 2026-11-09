# Gate 2 R15 — Authenticated Actor-to-Request Binding and Delegation Security

**Status: Development-only, offline authorization model; not deployable or approved for runtime. Gate 2 remains BLOCKED.**

## Verified baseline
- Independent branch from authoritative `main` `ff5e496685d1fb0ae244ce20d8f0e14bff1db7e6`; R12 PR #307 and R13 PR #308 merged.
- R14 PR #309 is an independent open draft, with a passing dedicated offline CI when checked; R15 does not depend on or copy unmerged R14 files.
- R12's HMAC PostgreSQL broker is disposable; R13's Ed25519 lifecycle is offline. Neither establishes a production signer.

## Threat and trust boundary
R14 demonstrates trusted service invocation but allows a trusted caller to name an actor, creating **confused-deputy impersonation** if a caller is compromised or a request-bound session is not verified. An issuer may not accept actor, tenant, branch, delegation or permissions solely from a caller-controlled payload.

A separate authentication authority must produce an unforgeable, short-lived, audience-specific, request-scoped authorization grant based on independently verified identity and current tenant authorization. This must bind **the actual authenticated actor**, workload, request identifier, operation, tenant and environment, and must be one-time-use. Issuer invocation must revalidate current actor/business/membership and caller status to prevent stale authorization after revocation. Caller-provided role upgrades or operation changes fail closed.

## Offline test contract
The Node 22 test suite uses `WeakMap`-backed opaque handles for simulated authenticated actor and attested workload identities, in-memory authorization state and one-time grant consumption. The issuer returns **unsigned intent metadata only**; this is not a bearer token, signing capability, production authentication method, network service, Hono middleware or PostgreSQL verifier.

Adversarial scenarios:
1. Identity derived from independently authenticated actor session, not caller claim.
2. A valid service without actor evidence cannot issue.
3. Injected actor or administrative role rejected.
4. Binding cannot be reused for a different tenant.
5. Operation cannot be widened or changed.
6. A different request ID cannot reuse the grant.
7. Environment is fixed by the authenticated service boundary.
8. One-time-use replay rejection.
9. Session/grant expiration denial.
10. Membership revoked between authorization and issue denies.
11. Disabled actor/suspended tenant deny.
12. Revoked service identity denies.
13. A separately authenticated actor cannot assume a foreign membership.
14. Unknown operations, forged handles and invalid identifiers deny without successful issuance.

## Outstanding blockers
- Real IdP JWT verification, session revocation, token binding, proof-of-possession and legitimate request-context construction are **not implemented**. A compromised API process could still impersonate users unless evidence originates outside that trust boundary and delegation restrictions are enforced.
- Existing production Hono/Worker authentication middleware is **not linked** to the offline grant, and customer, anonymous QR, background job, platform admin and staff permissions are distinct domains requiring separate contracts.
- Issuer workload authentication/KMS custody, database-recognized cryptographic verification, durable revocation and nonce atomicity, multi-instance replay, clock drift and fail-closed provider outages are unverified.
- The model's `WeakMap` and in-memory `WeakSet` are fixtures, not a secure distributed credential design or cross-worker replay protection.
- Hyperdrive still requires a nonprivileged broker role, end-to-end authorization-path verification and explicitly authorized staging cutover.
- Account for time-of-check/time-of-use races through transaction-bound permission revalidation or sound revocation epochs in a real implementation.

## Restrictions and next review
No live Neon changes, staging/production SQL, migrations, Cloudflare or Hyperdrive updates, privileged role creation, new secrets, economic activation, deployment, auto-merge or advancing to R16 without a separate owner decision. Independent human security review and exact-head hosted CI remain mandatory.

**A green CI result certifies only this offline negative-capability model; staging/runtime remains BLOCKED.**
