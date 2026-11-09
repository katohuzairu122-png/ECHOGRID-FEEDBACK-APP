# Gate 2 R16 — Authentication Evidence and Delegation Contract

**Development-only offline cryptographic model. Not a deployable issuer, credential, IdP integration, or PostgreSQL verifier. Gate 2 remains BLOCKED.**

## Verified baseline

- Independent branch from `main` `ff5e496685d1fb0ae244ce20d8f0e14bff1db7e6`. R12 #307 and R13 #308 were merged.
- R14 #309 and R15 #310 were open draft PRs when R16 began; the development block does not copy or merge them.
- Inspected `apps/api/src/auth/jwt.ts`, `middleware/authenticate.ts`, `middleware/customer-authenticate.ts`, and `middleware/tenant-context.ts`.

## Current implementation boundaries observed

- Staff access JWTs are HS256, `type: access`, with 15-minute TTL; an optional signed `sid` identifies an existing session. Legacy access tokens and impersonation tokens can lack `sid`. Current `authenticate` verifies the JWT and active user state; for impersonation it checks both subject and actor active state.
- The `impersonatedBy` claim signals platform-admin impersonation. Existing middleware exposes the impersonated user as `userId`, while `impersonatedBy` is used for audit. No R16 authorization may silently inherit this delegation or treat it as a normal-user proof.
- Customer JWTs use a distinct customer secret and middleware. Customer identity is not interchangeable with staff identity. Anonymous QR and background service flows need distinct rules.
- `resolveTenantContext` treats business/branch headers as selectors and independently checks staff membership, branch ownership and permission. Header values are not trusted database assertion authority.

## R16 security contract (proposal)

For future database assertion requests, require a trusted authentication-evidence verifier with:
1. Strongly authenticated source, explicit issuer/audience, algorithm pinning and independently verified session state.
2. An authenticated, active subject derived **only** from validated identity evidence, never user-supplied `actor` or service-selected subject text.
3. Required and valid session binding, explicit short TTL, operation/tenant/request/environment binding, independent current authorization and replay controls.
4. Explicit refusal of legacy sessionless and administrator impersonation tokens **until separate delegated-proof policy is approved**. Impersonation requires source administrator identity, target identity, verified grant, grant revision, scope, expiry, audit, revocation and independent authorization. Do not silently equate the admin with the target.
5. Domain segregation: staff, customer, anonymous QR, background service and platform operator each require different policy. No token type crossover or blanket service authority.
6. Fail-closed behavior on authorization-store outage, revoked sessions and suspended business; bounded clocks and explicit replay guarantees.

## Offline proof limitations

The standalone Node 22 harness uses an ephemeral, in-memory test HMAC key to model signature verification and protected claims, explicit test-only minting, session version state, current membership and per-session request replay. This is **not** use of the current live JWT secret or a proposed production signing format. The caller invokes a pure model, not Hono middleware or a trusted Worker's secret store.

Test matrix: valid actor proof, signature tamper, actor injection, foreign business, operation and environment widening, replay, expiry/future/type/audience mismatch, impersonation rejection, session revocation, membership and business revocation, missing session, foreign actor, and no successful audit record on rejection.

The test harness `used` set is not durable or atomic across instances, and fixture signing API is not a production issuer. The existing staff JWT implementation does not expose a fully issuer/audience/session-bound, externally attested actor grant. R16 **must not** pretend it does. Persistent session verification, delegation policy, true workload binding and a database-consumable signature remain unimplemented.

## Explicitly blocked

No changes to runtime auth code, operational JWT issuance, Neon SQL/migrations, Hyperdrive, Cloudflare secrets, payment/loyalty economics, staging credentials or production infrastructure. No merge/deploy/activation. A passing CI proves only the offline contract.

**Owner/security review must select an identity-evidence source and delegation policy before any runtime integration.**
