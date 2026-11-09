# Gate 2 B2 — Signed Actor/Session/Tenant/Operation Broker Feasibility

**Date:** 2026-11-09. **Development only.** No staging, production, Neon roles, Hyperdrive configuration, deployment, migration or financial activation.

## Baseline and scope

- Baseline `main`: `1562ec6e4c32e3d71c5b098230d1d250f01b623f`; B1 PR #318 is separate, draft and unmerged. B2 independently branches from main and does not assume B1 code is incorporated.
- Starts from R12's disposable single-operation signed broker concept, R16/R17 exact session evidence requirements, and B1 restricted login deny-by-default contract.
- The isolated PostgreSQL 18 test uses a 67/67 **synthetic disposable** migration replay, an ephemeral restricted LOGIN, a private verification-key table, modelled exact persisted sessions and memberships, one-use nonces, and a fixed function that returns only the approved synthetic branch row.
- The assertion binds `kid`, issuer, audience, actor, signed exact session ID, business, branch, operation, nonce, request ID and issued/expiry timestamps. HMAC-SHA256 is used **only for the test**; the test issuer generates a fresh random key, and the disposable database holds the same symmetric key. This is not an independently trusted issuance boundary, asymmetric key custody, KMS, or live verified identity provider.
- Signed requests are independently verified by the SQL function. A restricted login can execute precisely that function but cannot SELECT verifier keys, session metadata or underlying business tables. Signed-field mutation, foreign membership, expiry, overlong TTL, duplicate nonce, revoked session and disabled key must be denied. Fabricated `echogrid.tenant_id` cannot replace the signed business.
- The SQL broker uses a fixed `search_path`, revokes default PUBLIC EXECUTE and persists nonce consumption with an atomic uniqueness constraint. The privilege proof is local to this single synthetic function, not the full application.

## Explicit limits / blockers

1. **No trustworthy production actor evidence or signer isolation.** The synthetic test code can mint claims for arbitrary fixture actors because it controls the test key. A compromised real Worker with this key could impersonate actors. Production design must isolate issuance, perform independently verified subject/exact session checks and prefer asymmetric verification keys not held by the DB runtime.
2. HMAC verification uses a normal SQL string comparison, not a demonstrated constant-time comparison. Production crypto validation must receive algorithm-specific review.
3. The modelled session/member tables are disposable fixtures, not the application schema; no independent `refresh_tokens` chain validation, disabled user handling, workload proof, permission catalog, business status or branches/surveys/customer identities is integrated.
4. The broker's nonce consume is atomic for replay, but no concurrent revocation race, authorization-effect atomicity, cleanup retention or external provider effect is certified in B2. B3 must combine R18 and R19 patterns with real authenticated/authorized inputs in one transaction.
5. One-time nonce persistence cannot be treated as an audit-grade authorization without signed subject identity, approved issuer/key lifecycle and correct fail-closed behavior.
6. The Worker still uses `HYPERDRIVE.connectionString` for direct SQL in ordinary repositories. No server route or real Hyperdrive request uses this B2 fixture. Owner `neondb_owner` still has BYPASSRLS in the staging environment; this design does not repair or remove that live privilege.
7. Existing business tables not RLS-enabled, GUC scope spoofable, and the original staging branch remains 45/67 pending separate approval. No live staging security test was executed.

## Verification and exit criteria

- Dedicated PG18 workflow executes the exact B2 script only against `echogrid_ci_pg18_b2_broker` on localhost, with fixed test environment acknowledgement, pinned dependencies and 67 committed migrations.
- PR merge readiness requires exact-head passing dedicated CI and entire CI/CD, code review, negative case review, and a determination that no live feature or role has been accidentally enabled.
- **Next gate B3:** durable nonce and revocation with valid actor assertion, atomic ordering, concurrent sessions and stale evidence denial, still in disposable PostgreSQL. Subsequent B4 adapts real repositories nonfinancial read first; B5/B6 are live staging controls and owner release decisions.

**Expected verdict: disposable crypto-function feasibility only. Trusted issuer/runtime certification: BLOCKED.**
