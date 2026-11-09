# Gate 2 R18 — Durable Authorization and Concurrent Session Revocation

**Classification: disposable PostgreSQL 18 development feasibility. Not staging certification, a migration, a usable broker, or a production credential.**

## Baseline
- Branch created independently from `main` `ff5e496685d1fb0ae244ce20d8f0e14bff1db7e6` (R12/R13 merged).
- R14 PR #309, R15 #310, R16 #311 and R17 #312 remain independent draft work at inspection. Do not assume they are merged or copy their code.
- The existing `RefreshTokenRepository.isSessionLive` is an unlocked read of an exact user/session row. This is appropriate for some existing read-time checks, but by itself **does not serialize** a concurrent revocation against a newly committed database authorization.
- R18 does not alter that repository or the `admin-session` privileged administrative boundary.

## Disposable test
CI launches a dedicated localhost PostgreSQL 18 service with a uniquely named database, a fixed test credential, an explicit environment acknowledgement, and checked database/version identity. All synthetic tables are created in the isolated `gate2_r18` schema; no repo migration journal or Neon database is touched.

The test models a **transactional authorization record**. An issuing transaction takes `SELECT ... FOR UPDATE` locks on the exact actor/session, active business and membership rows, then persists an operation-scoped authorization record and commits. A compatible revocation updates that same session row, acquiring the conflicting row lock. Therefore:

- A revocation that commits **first** must cause an issuer waiting on the session lock to deny.
- An issuance that commits **first** may remain recorded, then the revocation commits; a subsequent issue must deny. Revocation cannot erase an already committed and potentially acted-on authorization.
- Two sessions for one user are independently scoped; a foreign user/session cannot substitute.
- Business/membership revocation committed first is denied; foreign-tenant memberships are denied.
- Authorized rows remain visible across independent PostgreSQL connections.

**Scope limitation:** The test does not concurrently race business/membership revocation against issuance, and it does not prove serializability against all account disablement, role policy updates or external effects. Those require compatible locking on the same rows and independently reviewed transaction boundaries. It also does not test real access-JWT signature verification, session-chain semantics, refresh rotation, token theft, nonce uniqueness under parallel issuance, revocation epochs, signer key custody or Hyperdrive pooling.

## Production prerequisites

1. Authoritative issuer-specific authentication and signed exact-session evidence (R14–R17 design gates) and current tenant authorization.
2. Defined lock ordering and isolation levels for *all* session, membership, business and policy transitions. Every mutation must participate in the same synchronization protocol, or use an independently proven epoch/version system.
3. Verified nonowner PostgreSQL broker role with no direct protected-table privileges; approved stored function(s) with fixed `search_path`, restricted EXECUTE and reviewed owner.
4. Durable replay nonce consumption and binding of actor, tenant, operation, audience, issuer, expiry, request and session; controlled retention and failure behavior.
5. Fail-closed behavior for database disconnects, aborted transactions and post-commit external effects. Transaction commits are not revocable once effects are visible; define compensation and idempotency separately.
6. Independent staged run under least-privileged credentials and actual Worker/Hyperdrive pool reuse, after owner-controlled staging-copy/backup approval.

## Restrictions

No live Neon SQL, production/staging migrations, new runtime role, credentials, key material, deployment, Cloudflare/Hyperdrive changes, Stripe/financial effects, customer onboarding, automatic merge or R19 advancement.

**Expected outcome:** disposable concurrent sequencing feasibility only; Gate 2 staging certification remains BLOCKED.
