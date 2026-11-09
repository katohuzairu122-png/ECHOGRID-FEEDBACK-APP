# Gate 2 R14 — Trusted Issuer Invocation Boundary (Offline Verification)

**Verdict: DEVELOPMENT-ONLY OFFLINE FEASIBILITY. Gate 2 remains BLOCKED.**

## Baseline and dependencies

- Source: authoritative `main` at `ff5e496685d1fb0ae244ce20d8f0e14bff1db7e6`, after merges of R12 PR #307 and R13 PR #308.
- R12 demonstrates a disposable PostgreSQL HMAC restricted-access broker, **not** a live signer or approved runtime database verifier.
- R13 demonstrates offline Ed25519 credential lifecycle behavior, **not** an authenticated production issuer, KMS service, PostgreSQL Ed25519 verifier, or durable revocation and replay store.
- R14 tests the next independent boundary: who may invoke an issuer and which authorization evidence it must consult. No live authority is created.

## Proposed invocation contract (NOT an implemented runtime interface)

A private trusted workload-authentication boundary must produce an issuer-recognized caller identity that **cannot be created by arbitrary HTTP headers, JavaScript claims, database SQL, public QR requests, queue messages, browser clients or arbitrary application callers**. The trusted caller is not itself sufficient to authorize an actor or tenant. The issuer independently verifies the caller's environment, current identity state, active tenant status, current membership, exact allowlisted operation and bounded TTL before generating any assertion.

The offline model represents caller authentication using non-exported `WeakMap`-bound session objects and represents current authorization using in-memory maps. That model is deliberately **not a real authenticated service binding**, an API integration, or secure proof that a compromised Worker cannot impersonate an actor. In particular, a real service must obtain actor authentication evidence tied to the *actual request*; allowing a trusted Worker to freely choose `actor` or `tenant` would permit confused-deputy impersonation. Implement authenticated actor-to-request binding before runtime.

## Verification cases

1. Attested test workload with current membership may invoke the single read-only allowed operation.
2. Forged plain objects and missing callers are denied.
3. Unknown workloads and environment spoofing are denied.
4. Revoked workload service identity is denied.
5. Cross-environment requests are denied.
6. Cross-tenant impersonation is denied by independent membership state.
7. Unauthorized operation and injected role claims are denied.
8. Disabled actor and suspended business are denied.
9. Membership revocation prevents new assertions.
10. Invalid request shape, missing tenant and excessive TTL are denied.
11. Failed requests do not produce successful issuance audit events.

These are in-memory negative-capability tests. The result is an **unsigned intent record**, with no cryptographic key, signature, token usable against PostgreSQL, database or Cloudflare binding.

## Required decisions before runtime work

- Owner selection of workload attestation topology, signing service and key-custody mechanism.
- Independently authenticated **actor-to-request** binding and authorized delegation rules (staff, customer, public QR, background jobs and platform administrators must be separate).
- Protection from compromised workload, stolen service identity, signer abuse and replay; independent audit and rate limiting.
- Database-verifiable signature algorithm/protocol and approved PostgreSQL extension or maintained verifier, if necessary.
- Durable revocation, membership policy versions, atomic nonce consumption, cleanup, retention and multi-instance consistency.
- Narrow SQL broker functions, least-privilege shared Hyperdrive role, connection-reuse testing, verified staging migrations and rollback policy.

## Explicit prohibitions

No merger authorization; no production/staging Neon SQL, Cloudflare deployments, Hyperdrive connection changes, live key/credential issuance, new migration numbers, customer onboarding or financial activation. A green R14 CI result proves only the offline invocation contract.

**Stop at owner review; Gate 2 certification remains BLOCKED.**
