# Gate 2 B4-06 — PostgreSQL 18 Ed25519 Verification Feasibility and Fail-Closed Boundary

**2026-11-09. DEVELOPMENT / DISPOSABLE CI ONLY.** Do not merge, deploy, change either Neon database, run original-staging migrations, change roles/credentials/Hyperdrive, or activate settlement or other financial operations.

## Baseline
- Repository main: `03988b80e5f1ed7a2c02c514292266e75b1dc045`; B4-01 through B4-05 code present on main at development start.
- B4-03 defines a development-only canonical Ed25519 `B4-03/1` assertion that PostgreSQL does **not** currently verify.
- B4-02 exercises a **different HMAC fixture** and restricted login. A successful HMAC test cannot justify deploying the Ed25519 issuer/broker bridge.
- B4-04 keeps the branch API broker path OFF. B4-05 static protocol gate always refuses runtime authorization.

## Database capability finding
Official PostgreSQL 18 `pgcrypto` docs cover digest, HMAC, password hashing, PGP *encryption/decryption*, and symmetric raw encryption. **It does not provide an arbitrary raw Ed25519 detached-signature verification routine.** PGP signing/verification is not supported there either. A different independently audited and approved verifier/extension or trust architecture is required. Do not substitute `hmac`, `digest`, comparing a claimed verifier flag or a caller-controlled `verified=true` argument.

Documentation: https://www.postgresql.org/docs/18/pgcrypto.html

## Disposable-only implementation
- GitHub Actions starts *fresh* localhost-only PostgreSQL 18 `echogrid_ci_pg18_b406`, checks its exact identity, and replays 67 migrations.
- A synthetic `gate2_b406` schema holds a fixture public key and an empty nonce table.
- Restricted CI-only login has `NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE`, schema usage and EXECUTE-only on one `SECURITY DEFINER` function, no direct table privileges.
- Crucially, the broker function unconditionally raises SQLSTATE **42501**. Neither a genuine externally verified Ed25519 signature nor an attacker-provided `claimed_verified=true` changes the outcome. The signature check is performed via Node WebCrypto **outside** PostgreSQL purely to prove the distinction between authenticity and SQL authorization.
- Tests demand denial for genuine and altered assertions, absence of direct public business-table and fixture key/nonce access, and **zero nonce consumption**. This is not a real read path, signed broker verifier, trusted issuer or authorization engine.

## Blocker and owner decision
**BLOCKED — reviewed PostgreSQL Ed25519 verifier not selected.** A proposal must establish support/availability on managed Neon PostgreSQL 18; cryptographic canonical-wire matching with B4-03; vetted code provenance, extension privileges, public-key rotation/revocation, exact-session and membership use-time checks, atomic replay ledger, restricted role grants and read-only tenant isolation.

If an independently verifiable in-database Ed25519 routine cannot be safely deployed on Neon, select a **different** signed protocol/trusted verification architecture through a separate owner-reviewed design, preserving no caller-asserted trust and no owner/Hyperdrive bypass. Any change would require its own verified security tests; do not silently downgrade the existing Ed25519 contract to HMAC.

The current original staging and production databases remain at the last verified 45 of 67 migrations; this test must never target them.

**Completion criteria:** dedicated disposable workflow plus full CI/CD must pass on exact head. Even then the only allowed verdict is `FAIL-CLOSED BLOCKER VERIFIED`; real database Ed25519 verification remains NOT IMPLEMENTED and B4-04 activation stays OFF.
