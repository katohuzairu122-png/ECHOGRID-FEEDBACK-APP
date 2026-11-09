# Gate 2 B4-07 — Neon Verifier Provider Capability and Trust Boundary Reconciliation

**Date:** 2026-11-09. **Authorization: DEVELOPMENT ONLY / read-only capability audit.** No original staging or production database modification, extension installation, Cloudflare/Hyperdrive changes, new credentials, migration, financial activation, deployment, or PR merge.

## Baseline and open dependency

- Authoritative main: `03988b80e5f1ed7a2c02c514292266e75b1dc045`; B4-01 to B4-05 files are present and merged.
- B4-06 PR #328 remains separate and unmerged at branch-creation time. Its disposable PostgreSQL 18 run passed, proving **deny-only**, *not* Ed25519 verification. Full repository CI was still running at last read. B4-07 does not copy or activate that implementation.
- B4-03 uses a **detached**, canonical `B4-03/1` Ed25519 assertion. B4-01/B4-02 use an incompatible HMAC fixture. B4-04 and B4-05 keep runtime broker activation OFF.

## Exact live Neon capability inspection — read-only catalog only

Inspected `pg_available_extensions` without `CREATE EXTENSION` on both:

| Environment | Neon project | Branch | Available matching extensions | Installed |
|---|---|---|---|---|
| Original staging | `lucky-glitter-47218268` | `br-bold-water-aukjlvw3` | `pg_session_jwt` 0.5.0, `pgcrypto` 1.4, `pgjwt` 0.2.0 | None of these |
| Production | `divine-voice-54333763` | `br-blue-paper-atrcoge1` | Same three, same versions | None of these |

The filtered `pg_available_extensions` catalog has no `pgsodium`, `ed25519`, `pg_tle`, `plpython` or `plrust` entry. This is **only an availability observation**; it does not prove that arbitrary functions are absent from all PostgreSQL namespaces or that Neon could never add another supported extension.

### Provider assessment

1. **`pgcrypto`:** PostgreSQL 18 documents digest and HMAC but **no detached raw Ed25519 signature verifier**, and `pgcrypto` PGP does not support signing. Incompatible with B4-03 as-is. Official docs: https://www.postgresql.org/docs/18/pgcrypto.html.
2. **`pg_session_jwt`:** The Neon-maintained extension supports JWK-validated **JWT** sessions. That is not necessarily equivalent to B4-03's detached, length-prefixed assertion. Its fallback mode reads `request.jwt.claims`, a **modifiable PostgreSQL parameter** when no JWK is configured; fallback MUST be prohibited. Official code/docs: https://github.com/neondatabase/pg_session_jwt. We have not proved a supported `EdDSA` JWT algorithm/JWK mode, safe key provisioning on Neon, token expiry across pooled connections, or independent immutable claim binding. Do not install or configure this extension from this PR.
3. **`pgjwt`:** Available but unexamined as an EdDSA detached verifier; no compatibility or security certification. Do not infer Ed25519 support from the extension's name.
4. **Independent trusted broker service:** A *possible alternative architecture* uses isolated Workload Identity to authenticate a narrowly authorized broker service, verifies the issuer's Ed25519 assertion using WebCrypto at that service, then executes fixed SQL with credentials unavailable to ordinary app Workers. This **moves the trusted boundary** to service custody and must prove the service cannot be impersonated by a caller who can obtain the DB credential. It is NOT equivalent to arbitrary app-side `verified=true`; a dedicated authenticated broker, exact request/session/tenant revalidation, fixed query, atomic nonce, role restrictions, rotation and pooling tests are required. Neither approved nor implemented.

## Tested fail-closed decision contract

The dormant `broker-verifier-provider-decision.ts` enumerates these candidates and always returns `authorized:false` and `brokerEnabled:false`, even if a caller claims `verified:true`, `certified:true`, or `jwkConfigured:true`. Unit tests prohibit HMAC downgrade, mutable JWT claim fallback, unaudited JWT adoption and premature trusted-broker-service activation. The module is not imported into runtime routes and does not provide cryptographic verification.

## Recommended next owner-reviewed architecture decision

Prefer an **independent authenticated, isolated broker service** only if a standalone threat model demonstrates custody of restricted DB credentials and protects its invocation from an ordinary Worker and a malicious tenant. Otherwise request Neon support for an independently audited compatible Ed25519 verifier. Neither is approved automatically.

Before B4-04 activation:

- Confirm a single canonical signed protocol; independently prove issuer private-key lifecycle and public key verification at the actual trust boundary.
- Establish an unforgeable workload identity and strictly privileged, non-owner PostgreSQL role. The existing staging and production `neondb_owner` Hyperdrives are not acceptable.
- Use-time: check exact persisted session, actor, tenant membership, branch ownership, permission and revocation under a coherent writer/revocation serialization protocol. Consume nonce atomically, reject rollback/replay and cross-tenant attempts.
- Certify Cloudflare pooled connections, teardown, separate staging/production secrets, audit logging without exposure, and emergency rollback.
- Protect original staging and production migrations behind separate explicit approvals.

**Final scope verdict:** Neon extension capability examined, incompatible claims fallback rejected, options and blockers documented. No end-to-end signature verification or broker activation achieved.
