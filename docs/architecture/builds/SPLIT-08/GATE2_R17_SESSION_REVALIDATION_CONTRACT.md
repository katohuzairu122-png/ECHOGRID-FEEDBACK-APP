# Gate 2 R17 — Session Verification and Revocation Integration Contract

**Status: development-only isolated model; runtime and staging authorization BLOCKED.**

## Authoritative baseline

- Branch originates independently from `main` at `ff5e496685d1fb0ae244ce20d8f0e14bff1db7e6` (R12 and R13 merged).
- R14 #309, R15 #310 and R16 #311 remained open drafts at start. R17 does not copy unmerged code or assume merge.
- R16 dedicated security workflow passed but its main CI/CD was **failing** when inspected. Do not treat R16 as mergeable or integrated without resolving that failure.
- Inspected actual staff JWT / `authenticate`, `AuthService` refresh-token lifecycle, and `billing/stripe-read/admin-session.ts`.

## Observed code and security gap

The ordinary staff `authenticate` middleware verifies access-token signature and active user state, and checks impersonator active status if present. It does not require the token's optional `sid` or validate exact persisted session state. As a result, ordinary staff-route authentication must **not** be treated as sufficient authority for the proposed issuer.

A narrower preexisting privileged path, `authenticateAdminSession`, requires a signed session ID and checks `refreshTokens.isSessionLive(userId, sid, now)`. The corresponding `createSessionRevalidator` checks the exact session at each privileged use, including token expiry and administrator status. This pattern is a **reference** and remains unchanged. Its scope is Stripe read administration, not tenant broker issuance.

## Proposed issuer-specific integration contract

1. A separately approved boundary validates a pinned access-token issuer/audience/algorithm, obtains an authenticated staff subject, and requires a signed, valid `sid`. Legacy sessionless tokens are denied issuer authority. Admin impersonation tokens are denied unless separate delegation policy exists.
2. An exact persisted session is resolved by **subject plus session ID**, checking active user, unrevoked session chain, expiration and authoritative session status at time of use. A different live session must not satisfy the check.
3. Tenant selection remains untrusted until current membership, active business, branch ownership and exact operation permission are proven.
4. The issuer must revalidate session and scope **immediately before** assertion issue. For a real database effect, atomic authorization/side-effect ordering or provably safe revocation epochs must prevent time-of-check/time-of-use races.
5. Failure to load authorization state, ambiguous repository results or a disconnected verifier must deny. Do not substitute stale KV caches, mutable caller claims or session-scoped PostgreSQL GUC values.
6. Keep staff, customer, platform admin, anonymous QR and background job authority distinct. Customer JWTs, anonymous QR signatures and Stripe evidence are not interchangeable with staff access tokens.
7. Record minimal, redacted correlation identifiers and decisions, not raw JWTs, refresh tokens, signer secrets or personal data.

## R17 offline verification

The standalone Node 22 test-only model uses opaque `WeakMap` contexts and synthetic persisted session/membership state. It covers 14 cases: exact session allow; forged context denial; same-user other-session independence; foreign-session denial; revoke-all; account deactivation; membership and business revocation; store outage; token and context expiry; sessionless/impersonation rejection; forbidden action; and failure audit invariants.

**Crucial limitation:** The fixture `authenticate` is not a real signature verifier, and its session/map data are not a PostgreSQL transaction. The JavaScript revision check illustrates stale-state refusal, not a race-free authorization protocol. No production issuer, API route or database verifier exists as a result. A passing test cannot certify live instant revocation, cross-worker consistency, Hyperdrive behavior, durable nonce consumption or the scope of `refreshTokens.isSessionLive` under actual runtime credentials.

## Independent review gates

- Resolve the existing R16 main CI failure before considering its merge.
- Approve issuer-specific staff JWT evidence policy and sessionless/impersonation behavior.
- Prove strict session/user binding, persisted revocation races and fail-closed DB behavior against disposable PostgreSQL and a restricted role.
- Specify how issuer request-scoped evidence survives pooling without session state leakage.
- Approve cryptographic verifier, key custody, replay durability and explicit operation matrix before future runtime integration.

**Restrictions:** No migrations, live Neon SQL, Cloudflare/Hyperdrive change, production credentials, Stripe/provider reads, economic activation, merge or deployment. Stop at separate owner review.
