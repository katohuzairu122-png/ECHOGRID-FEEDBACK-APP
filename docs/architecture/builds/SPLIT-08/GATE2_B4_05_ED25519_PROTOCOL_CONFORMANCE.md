# Gate 2 B4-05 — Ed25519 Broker Protocol Conformance and Downgrade Prohibition

**2026-11-09 — development-only; dormant.** No merge, deployment, staging/production SQL, Neon role, credential, Hyperdrive edit, migration, financial activation or route cutover.

## Baseline and dependency review
- Independent authoritative `main`: `19c489ef1db977abc10fa5186ac183c135bcc816`.
- B4-01 #323, B4-02 #324, B4-03 #325 and B4-04 #326 are separate, open/unmerged review branches at start. The last B4-04 CI/CD and PG18 compatibility checks succeeded on exact head `3e0223531e4d4309e4caf037001e8e0f30c91047`.
- B4-01 defines a 13-value HMAC-shaped adapter pointing at `gate2_b4.read_one_branch`; B4-02 tests a HMAC synthetic SQL function named `gate2_b4_02.read_one_branch`; B4-03 creates a canonical, signed Ed25519 `B4-03/1` development-only assertion and a public-key-only verifier; B4-04 preserves the existing route and rejects broker mode. **No existing PR implements an end-to-end compatible authenticated broker.**
- The new module intentionally does NOT import files from unmerged PR branches or alter route handlers. It freezes the intended version, algorithm, domain, issuer, audience, workload identity, operation, permission and exact 20-field ordered list from B4-03. It denies HMAC aliases, renamed function assumptions, reordered fields, malformed descriptors and future compatibility bypass.
- A metadata comparison is not cryptographic proof. Even a structurally compliant descriptor or a caller-declared `databaseVerifierCertified=true` and `trustedRuntimeCertified=true` cannot turn the gate on: every result has `compatible:false`, `runtimeAuthorized:false`.

## Why deployment is blocked
1. An owner-approved, independently trusted issuer/workload identity and signing-key lifecycle/custody architecture is absent.
2. No approved PostgreSQL Ed25519 verification implementation or independently certified broker verifier is installed; do not translate Ed25519 assertions into HMAC tokens, accept a caller's `verified` flag, or claim SQL's HMAC fixture verifies Ed25519.
3. Current persisted session and permission revocation use-time checks are not proven to serialize with every writer; a stable revocation epoch or equivalent cross-writer protocol is needed.
4. Current runtime Hyperdrive uses `neondb_owner` with `BYPASSRLS`. No restricted staging runtime login or verified pooled-connection isolation is provisioned.
5. No live or isolated real Worker route proves signed actor, exact session, business and permission authorization through a restricted PostgreSQL login. The legacy `GET /branches/:id` remains unchanged.

## Further development gates
- Independent contract review: ensure B4-03 canonical byte encoding, exact claims, key rotation/revocation and signed operation rules form a single binding protocol. Preserve `authorizationVersion:null` as a blocker, not a fabricated privilege version.
- Design and prove a secure database verification path against asymmetric test vectors using **disposable PostgreSQL 18 only**, including public-key custody and negative cases. Do not introduce an unapproved extension or live SQL function.
- Agree and test consistent privilege/revocation serialization. Then implement genuine restricted LOGIN/GRANTs on a disposable database and validate hostile cross-tenant operations.
- Only after protocol, identity and runtime privileges are certified may a separate owner-approved branch activate a nonfinancial route. Original staging and production migration remain separately gated.

**Current verdict:** static conformance foundation only; **not a database verifier, issuer, broker, or deployment permission**. Require exact-head full CI and independent review before merge.
