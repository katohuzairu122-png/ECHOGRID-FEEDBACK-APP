# Gate 2 B3 — Atomic Signed Assertion, Nonce Replay and Session Revocation Race

**2026-11-09 — DEVELOPMENT/DISPOSABLE CI ONLY.** No live Neon, Cloudflare, Hyperdrive, credentials, staging migration, deployment, production access or PR merge.

## Baseline

- Independent baseline main `1562ec6e4c32e3d71c5b098230d1d250f01b623f`; B1 #318 and B2 #319 were unmerged when development began.
- B3 is a fresh, self-contained disposable PostgreSQL 18 experiment, not a live implementation and not a cherry-pick of B1/B2 drafts. The test incorporates the B2 fixture assertion model as a baseline, extends the database verifier and session row lock, and exercises nonce/revocation races.
- `GATE2_B3_DISPOSABLE`, exact loopback `DATABASE_URL`, `GITHUB_ACTIONS=true`, checked database identity, role, server version 18 and 67 applied migrations are required. All roles and tables exist only in the CI service database `echogrid_ci_pg18_b3_broker`.

## Single database-boundary proof

A restricted LOGIN is granted EXECUTE on one synthetic fixed-branch SQL function and nothing else. This `SECURITY DEFINER` function:

1. Validates versioned HMAC fixture assertion with issuer, audience, key id, subject, exact persisted session ID, business, branch, operation, request ID, nonce and bounded lifetime. HMAC secret is fixture-only and shared with database verifier; **not a real trusted issuer**.
2. Checks an exact active session with `SELECT ... FOR UPDATE` (implemented in PL/pgSQL using `PERFORM ... FOR UPDATE`), serializing against compatible session revocation `UPDATE` on that row.
3. Checks active scoped membership and branch using a separate locked membership row, then inserts a unique nonce into a durable synthetic registry within the same transaction as the fixed read. The caller's transaction rollback also rolls back nonce consumption.
4. Returns only the bound synthetic branch record after the checks. Untrusted GUC settings cannot override signed scope. Direct table access and verification-key reading are denied.

## Concurrency and failure matrix

| Scenario | Required proof |
|---|---|
| Two independently connected SQL clients submit the *same* signed nonce concurrently | Exactly one success, exactly one SQLSTATE 42501 denial |
| An authorization and its nonce are rolled back in the caller transaction | A later identical signed attempt succeeds once, then replay is denied |
| Session revocation acquires session-row lock before authorization | Concurrent authorization waits; revocation commits; authorization denies |
| Authorized operation holds session-row lock before revocation | Authorized operation commits; revocation follows; subsequent authorization denies |
| Actor, session, tenant, branch, action, issuer, audience, request or nonce is tampered | Denial; signature and scope are not bypassable by a caller |
| Membership absent, assertion expired/overlong, verifier key revoked, or direct SQL attempted | Denial |

## Limitations and blockers

- The tests use synthetic session/membership/key stores and **test code can mint assertions for any fixture user**. They do not establish an external trusted identity issuer, key rotation custody, production JWT validation, disabled-user/impersonation logic or workload attestation.
- The HMAC verifier demonstrates cryptographic equality but not a production-reviewed constant-time verification algorithm. The fixture key is inside the PostgreSQL test database, not production KMS/asymmetric-verification custody.
- The per-session row lock serializes revocations that update the exact same row. A broader global logout, membership/business disable or revocation version system must conform to the same concurrency contract. B3 does not test external provider effects, real authentication stores, true application authorization, pooling leaks or process crash recovery.
- This function is a simulated narrow read; it is **not** an API or a generally usable customer/financial broker. Existing application repositories still execute direct SQL and require B4 staged adaptation.
- A database owner with BYPASSRLS remains unsafe as a Worker runtime identity, and historical Hyperdrive `neondb_owner` observations need live independent verification.
- Any CI success applies exclusively to a PostgreSQL 18 disposable runner. It does not authorize applying migrations 0045–0066 to original staging, changing the staging Worker/Hyperdrive, creating Neon roles, merging PRs or activating financial flows.

## Exit conditions

B3 becomes development-verifiable only after **exact-head B3 GitHub Actions PASS**, full CI/CD PASS and independent review; otherwise report conditional/failure, fix the same branch, and retest. Follow-on B4 must translate these principles into a minimal audited nonfinancial operation backed by actual repository authorization and a trusted issuer boundary, again before live integration.

**Current scope verdict:** disposable atomic transaction proof; live runtime certification BLOCKED.
