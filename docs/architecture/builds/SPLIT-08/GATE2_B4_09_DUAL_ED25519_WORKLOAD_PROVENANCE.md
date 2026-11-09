# Echo Grid — Gate 2 B4-09 Isolated Workload Provenance Prototype

**2026-11-09 — DEVELOPMENT ONLY. NOT DEPLOYABLE.**

## Starting point

- Authoritative main `03988b80e5f1ed7a2c02c514292266e75b1dc045`.
- B4-08 remains independent open draft PR #330; this block does not assume it is merged.
- Existing B4-03/1 development Ed25519 claims, signed assertion and public-key verification are retained without protocol downgrade.
- Live Neon production and staging are both at 67/67 migrations. Existing production Cloudflare Hyperdrive uses `neondb_owner`, a BYPASSRLS login. **This block does not touch it.**

## Prototype

`apps/api/src/auth/broker-workload-attestation.ts` implements an **unmounted** B4-09/1 Ed25519-signed workload provenance envelope. It binds the B4-03 signed assertion bytes and signature through SHA-256; signs domain-separated, fixed-field, UTF-8-byte-length-prefixed workload evidence using a **distinct** Ed25519 identity. Both verifying public keys are resolved through independently supplied trusted key sources. No embedded private keys, credentials, role grants, arbitrary SQL, caller-supplied identity verdicts, or HTTP routes are introduced.

The pure verifier rejects malformed envelopes, wrong workload/audience, bad keys/signatures, assertion tampering, mismatched digests, future/expired attestations and key validity violations. Even successful cryptographic verification always returns `brokerAuthorization: 'NOT_GRANTED'` and `deploymentAuthorized: false`.

**Security boundary:** Cryptographic verification of two signatures does not prove Cloudflare invocation identity, actual protected key custody, request replay prevention, actor/session revocation, at-use membership authorization, SQL grants, or tenant pool separation. Source-controlled or caller-injected public keys must not be trusted by a runtime. This prototype is intentionally not mounted in the API and is not a replacement for a separately authenticated service binding, an issuer service, or the restricted PostgreSQL broker.

## Independent certification requirements

1. Select and implement the true Cloudflare service-to-service authentication boundary; verify the external caller cannot choose the workload identity or key set.
2. Separate production/staging/private-key custody and rotate/revoke keys, including race and compromised-key tests.
3. Implement persisted, atomic nonce/replay and exact session/tenant/branch/RBAC checks during the broker use transaction.
4. Implement the restricted nonowner PostgreSQL identity and exact allowlisted, no-arbitrary-SQL operations in disposable PostgreSQL 18; adversarial direct CRUD denial.
5. Exercise a realistic Cloudflare invocation and Hyperdrive connectivity on an isolated staging fixture, including cross-tenant attempts, expired/revoked sessions, partial outages and rollback.
6. Require explicit independent architecture approval, integration, successful exact-head CI and controlled release workflow before any staging/production deployment.

**Verdict:** B4-09 provides a testable cryptographic workload-provenance component only. No deployment/settlement authorization is granted.

## Handover remediation and live release blockers — 2026-11-09

Review of head `27b3d03c4b028a2f913825d553003830235faf26` reproduced two defects:

- One public key could sign both roles under different key identifiers. The verifier now compares the actual public key bytes and rejects reuse, while preserving distinct trusted sources.
- Workload fields could be replaced during asynchronous assertion-key lookup, allowing the final signature check to use fields different from those checked initially. The verifier now snapshots the complete envelope before asynchronous work and copies each resolved key record.

Both new negative tests failed against the original implementation (11 passed, 2 failed) and pass after correction. Distinct public keys remain necessary but insufficient proof of independent custody.

Read-only handover verification confirmed both named Neon branches have 67 migration records and 9 FORCE RLS tables; `neondb_owner` has BYPASSRLS in both. Production Hyperdrive `542dd173d3d14d54ac66c0f1f69e5ff9` still uses that role. The API has no service binding to an isolated broker. No live settings were changed.

Production still serves API version `9341d663-d10d-444c-a1d5-460fb4dd1a6d` and web version `cb05b5b8-9bc8-4347-b91a-9b2f03e34cb0`, both deployed October 22. GitHub's `production` environment currently returns an empty `protection_rules` array. `deploy-production.yml` and `docs/PRODUCTION-RELEASE.md` require independently configured required reviewers; a typed deployment phrase does not replace approval. Owner configuration of that gate and owner-controlled integration are required before release. No workflow dispatch or deployment was performed.
