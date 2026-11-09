# Gate 2 B4-03 — real authentication issuer development foundation

Development only, unmounted. No production certification, broker execution,
financial authority, credential/Hyperdrive change, schema migration or route.

## Reconciliation

Main: `19c489ef1db977abc10fa5186ac183c135bcc816`.
B4-01 PR #323 is OPEN at `02cac6d1fdbbae952f17797f639d667455bab783`.
B4-02 PR #324 is OPEN at `1712085be0ae8bb1bfcd11a18946fa91eb89bc9f`.
Both have successful exact-head checks. Neither dependency is merged or copied.
The former declares `gate2_b4.read_one_branch`; the latter tests a different
`gate2_b4_02.read_one_branch` fixture. Both use a 64-hex HMAC signature contract.
The existing R13 design explicitly leaves PostgreSQL Ed25519 verification and
isolated issuer custody/topology for an owner decision. These remain blockers.

## Foundation implemented

The issuer accepts a raw Bearer token and business/branch/operation selectors
only. Existing `verifyAccessToken` verifies HS256; signed `sid` is mandatory.
Legacy, impersonation, refresh/customer/service tokens are refused. Persisted
active user, exact live refresh-token session, tenant membership, usable
business, tenant-owned branch and `branches:view` are independently checked.
`branches:read` is the only operation. Existing repositories and RBAC service
remain authoritative; routes and ordinary authentication are unchanged.

A separate trusted composition root must supply the authorization DB connection,
access-token verification secret, public key source and signer capability. No
production factory, configuration default, issuer endpoint or private key is
provided. Tests use disposable keys. The signer cannot receive arbitrary actor
claims from a request; it receives the canonical message constructed after DB
checks. JWT and key validity are checked again after asynchronous signing.

Lock order: user, existing exact-session rows, business, branch, then the
permission-bearing grant/role/role-permission/permission chain. SHARE row locks
serialize UPDATE/DELETE revocations with issuance. Lock timeout and storage
failure deny. PostgreSQL tests use real schema rows and barriers for the two
session-revocation orderings. This is an issuance-time acceptance point, not a
promise that assertions remain authorized after commit. Concurrent insertion
of refresh-token successors and complete session lifecycle serialization are
not certified by these row-lock tests; a stable session/revocation epoch and
shared writer protocol must be reviewed before runtime integration.

## Wire and cryptography

`B4-03/1` is explicitly development-only, domain-separated Ed25519 over fixed
field order and UTF-8 byte-length prefixes. Issuer, audience, workload, key/version,
staff actor, exact session, tenant, branch, operation, permission, generated request
ID and nonce, issuance/expiry and null authorizationVersion are signed. TTL is at
most 60 seconds and bounded by JWT/key expiry. The schema has no coordinated
revocation version; null acknowledges this instead of inventing one.

WebCrypto is compatible with the Workers execution model. The public-key-only
verifier checks strict shape, algorithm, scope, TTL and current trusted key state.
Tests include RFC 8032's public test vector, canonical encoding and tampering.
Private keys never enter database rows, runtime configuration files or logs.

## Explicit integration blockers — no insecure fallback

This assertion must NOT be translated to B4-01's HMAC shape, accepted via a SQL
"verified" flag, or used to consume a broker nonce in application memory.
Cryptographic validity is not authorization; results say NOT_GRANTED. Replaying
signature verification does not grant or execute anything. Existing B1/B2/B3
PG18 workflows independently prove restricted SQL, nonce/replay and fixture
session serialization, not an end-to-end Ed25519 bridge from this issuer.

Before integration the owner must approve isolated issuer/workload authentication
and key custody, a reviewed PostgreSQL asymmetric verifier (or another approved
protocol), the coordinated session/authorization revocation mechanism, and the
least-privilege issuer read surface. Current foundation DB access is not a new
restricted runtime credential. No grants or Hyperdrive settings are changed.
The database broker must revalidate current authority and consume nonces atomically
at use time. Production pooling and tenant-transfer resistance remain uncertified.
B4-04 and any route activation require separate authorization.
