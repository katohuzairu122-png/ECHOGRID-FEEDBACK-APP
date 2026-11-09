# Gate 2 B4-08 — Isolated Broker Service Threat Model and Credential Custody Gate

**2026-11-09. DEVELOPMENT ONLY — NOT A BROKER IMPLEMENTATION.** No merge, deploy, staging or production database write, extension install, secret rotation, Hyperdrive edit, original migration, or financial activation.

## Repository baseline and dependencies

- Independent starting main: `03988b80e5f1ed7a2c02c514292266e75b1dc045`.
- B4-01 to B4-05 exist in main. B4-06 PR #328 and B4-07 PR #329 were open at start.
- B4-06 disposable PG18 deny-only workflow passed; its original full CI failed a missing `TextEncoder` Node import. A minimal test-only fix was committed as `83f7e69490f4456f2c9c7d6a2303b43b37e4bbb2`. Await exact-head CI; do not merge until green.
- B4-07 independently inspected Neon original staging and production extension availability. Its CI was in progress at last verification; no extension was installed.
- The existing B4-03 `B4-03/1` detached Ed25519 assertion format and B4-02 HMAC disposable fixture remain intentionally distinct. B4-04 branch broker route stays OFF; B4-05 protocol conformance remains deny-only.

## Proposed architecture — not authorized

Two distinct workload identities are necessary:

1. **Ordinary API Worker:** handles customer/staff HTTP requests but holds *no* dedicated broker SQL credential or private signing-key material. It cannot call broker SQL functions directly. A bearer token, client header or tenant GUC must never become broker service identity.
2. **Isolated broker service:** has a separately authenticated, non-forgeable service invocation boundary; independently verifies exactly the canonical B4-03 Ed25519 assertion using trusted public key lifecycle and checks active issuer/workload trust. It owns only a dedicated restricted nonowner PostgreSQL login, not `neondb_owner`, exposed to no other Worker, and uses fixed SQL/revocation/nonce transaction behavior.
3. **Authorization store and writer coordination:** the service rechecks exact persisted session, business membership, branch ownership and `branches:view` at **use time**, not issuance alone; revocation writers must serialize with the broker's authorization transaction, with atomic nonce recording and correct rollback/replay semantics.
4. **Pooling and environment isolation:** prove no tenant principal or privileges persist across pooled requests; staging/production credentials and service identities are isolated. Provisioning/deployment must occur in independent reviewed blocks with rollback.

Important: an API Worker compromised by an attacker could still invoke its permitted broker capability. The broker must bind caller workload identity and request-specific signed actor/session/business/branch/operation, enforce rate/abuse constraints, and never allow arbitrary SQL. A shared secret HTTP header alone is not sufficient as an unforgeable workload boundary.

## Development artifact

`apps/api/src/auth/broker-service-trust-contract.ts` is a **pure planning evaluator**. It enumerates requirements and refuses unsafe proposed topologies. Tests include shared app/broker credentials, privileged owner login, shared Worker, caller-supplied verification, downgraded HMAC protocol, missing exact-session/permission revalidation, nonce/transaction failures, revocation races, pooling context leakage, and logging disclosure.

**No input ever results in deployment authorization**, including a complete self-declared compliant topology. A planning checklist cannot validate actual Cloudflare service-token / mTLS / binding provenance, public/private key custody, database privileges, or live SQL behavior. A separate threat-reviewed implementation and disposable Cloudflare/PG18 exercise are mandatory.

## Remaining architecture decisions and test plan

- Select a workload-authentication implementation supported by the Cloudflare runtime, including explicit source-service identity and anti-replay behavior. No authentication by user-input header, role name, or mutable client-provided boolean.
- Decide where issuer signing keys live and which distinct service can access them; implement public-key rotation and revoked-key denial.
- Define the canonical request transport preserving all B4-03/1 signed bytes and exact issuer/audience/workload binding.
- Implement restricted broker storage in disposable PG18, with no blanket table access; certify denial under all direct CRUD attempts.
- Test cross-tenant, missing permission, expired/deleted session, account suspension, simultaneous revocation, concurrent nonce replay, rollback, pool reuse and forced DB outage.
- Integrate one nonfinancial route under a separately reviewed OFF-by-default flag; independently approve runtime credential cutover and deployment only after all negative cases pass.

**Verdict:** B4-08 is a trust/topology specification and static negative test gate. It grants no runtime service, issuer, database verifier, production credential or migration authority.
