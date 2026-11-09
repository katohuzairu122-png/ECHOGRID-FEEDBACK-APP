# Gate 2 R13 — Trusted Assertion Issuer and Credential Lifecycle Design

**Status: PROPOSED DESIGN + OFFLINE TEST CONTRACT. NOT APPROVED FOR RUNTIME, DATABASE OR CLOUD DEPLOYMENT.**

## Verified baseline and scope

- Authoritative `main` when R13 started: `ae9026e5bcf43d05e2bd733f3b98fc02b8824d55`.
- R12 draft PR #307 is open/unmerged; its exact-head CI, including the disposable signed broker proof, passed. R13 is independently branched from main and does not copy R12 files.
- The staging Hyperdrive configuration currently uses privileged `neondb_owner` with BYPASSRLS. Live staging remains 45/67 migrations at last direct inspection. **Neither credential, connection nor database is changed here.**
- R12 uses test-only HMAC known to both the simulated issuer and PostgreSQL verifier. R13 explores **Ed25519 asymmetric signing** to avoid distributing the assertion-signing private key to the database; this is **not a selection of a production PostgreSQL signature-verification implementation**.

## Trust boundaries and roles

1. **Identity provider / API authentication:** verify staff JWT and current user state. Validate active business membership, branch scope, platform role, customer identity and required permission for the *specific operation*. Tenant identifiers in HTTP headers are selectors only, not authority.
2. **Isolated issuer:** receive an authenticated, permission-checked, narrowly scoped authorization request from a trusted application boundary. Never accept unsigned claims of issuer authority from public clients, job metadata or an ordinary Worker database credential. Enforce an allowlisted operation, short TTL, audience, tenant, actor and operation before signing. Independent operator/administrative privileges and a security-audited issuing API are required.
3. **Signer key custody:** signing **private** keys stay with the isolated issuer's protected key service/HSM or equivalent; they must not appear in browser bundles, the shared Hyperdrive connection, arbitrary SQL execution, source control, CI secrets, logs, database tables or response payloads. Database verifier gets **only public verification keys**. Never make a shared database role an issuer.
4. **PostgreSQL data broker:** a low-privilege shared login is granted only EXECUTE on specifically reviewed authorization functions. Verify signature, key version, issuer, audience, actor/business/operation, expiry, revocation and atomic nonce consumption before returning exactly scoped rows. No generalized dynamic SQL, arbitrary actor-to-tenant selector, direct table CRUD or financial role memberships.
5. **Authoritative policy state:** membership/role revocations must be effective independently of assertion TTL. Verification should consult current, safely accessible state or a versioned revocation epoch persisted and updated atomically with privilege changes. The issuer and verifier must not rely on stale, unverified caches to authorize financial or sensitive operations.
6. **Replay control:** nonces are cryptographically random and unique to an assertion, consumed **atomically** at the database boundary (unique key plus transaction). A consumed nonce rejects retry. Retrying a lost response requires a separate idempotent result lookup or fresh authorized assertion, **not** silent replay acceptance. Cleanup must honor TTL and retention bounds, and avoid unbounded growth.
7. **Hyperdrive:** no reliance on connection-local custom GUC or login switching. Each broker operation should be a transactionally self-contained bounded call and should not require retaining identity in a pooled session. Verify connection reuse and fail-closed behavior with actual staging Cloudflare after authorization.

## Proposed assertion contract (not an accepted wire format)

Version `eg-broker-v1`, fixed canonical encoding, audience `echogrid:db-broker:v1`, trusted issuer identifier, `kid`, authenticated `sub` (actor UUID), business UUID, allowlisted operation, random nonce UUID, `iat`, `exp`, actor revocation epoch and business revocation epoch. Signature algorithm is **Ed25519** in the offline PoC.

Signing binds all fields; verifier must reject extra/missing fields, malformed canonical data, unexpected algorithm or key identifiers, mismatched action, excess TTL, future issuance, expiry, revoked key/actor/business, missing current membership and reused nonce. **No client-supplied key/algorithm selection.** Avoid key-confusion and cross-environment reuse. Keep staging and production issuer roots separate.

## Key lifecycle: required controls

- **Provision:** generate keys in a dedicated protected issuer environment. Record key ID, algorithm, purpose, environment, creation, not-before, not-after, owner and authorization/audit metadata. Publish public-key fingerprints for independent verifier inventory; do not expose private-key material.
- **Rotation:** provision next key and distribute its verified public key to verifier before first issue. Overlap until all old assertions expire; stop old-key issuance, revoke old verifier key when safe, and log cutover. Emergency revoke immediately; plan fail-closed availability tradeoffs.
- **Compromise:** revoke the affected key ID and outstanding assertions, independently invalidate actor/business epochs if required, rotate issuer credentials, audit access and trigger incident response. A stolen signing private key can generate convincing claims; current membership and expiry must remain mandatory.
- **Revocation:** actor disable, membership removal, branch-role change, business suspension and policy-version change must update a trusted revocation source in a well-defined order. Define max inconsistency window and forbid authorization when the authoritative store is unavailable.
- **Issuer service identity:** require mutually authenticated service-to-service trust or equivalent strongly bound workload identity, least privilege and permission-specific audit. Prevent a public caller from invoking the signer with arbitrary actor/business scope.

## Offline R13 CI evidence (limited)

The `node --test` suite uses fresh ephemeral Ed25519 keypairs and in-memory state to test: legitimate assertion, unauthorized issuance, claim tampering, expiry, new/old key overlap, key revocation, actor/business revocation, membership removal, nonce replay, verifier public-key-only inventory and disallowed operation. The tests require no database, network, Cloudflare resource or real credential.

**These tests cannot certify:** the issuer's trusted identity, production key management, actual PostgreSQL Ed25519 verification and privilege model, durable atomic replay protection, concurrency, revocation propagation, SQL injection safety, end-to-end Hono/Worker/Hyperdrive boundary, cross-region failure behavior, latency or complete tenant domain coverage. Passing CI proves only that the modeled contract behaves as specified.

## Implementation decisions needed before R14 / staging runtime

1. Owner selects trusted issuer topology: isolated Cloudflare Worker with guarded service bindings, independent KMS-backed signing service, or other audited mechanism. Define who can call and how actor permissions are verified; no architecture auto-selection.
2. Verify a maintained, security-reviewed PostgreSQL Ed25519 verification method (or alternative cryptographic protocol). PostgreSQL `pgcrypto` HMAC proof from R12 **does not** establish native Ed25519 support. Do not add a DB extension without explicit review.
3. Define append-only audit/replay tables, retention, policy-version epoch durability and key inventory in schema with nonowner FORCE RLS where appropriate; independently review `SECURITY DEFINER` search paths.
4. Audit every API/data path (staff, platform, customer, QR anonymous, background jobs) and specify precise operation grants before changing runtime credentials.
5. Owner-controlled staging-copy migration/recovery, nonowner authorization testing and Cloudflare Hyperdrive compatibility remain separate release gates.

## Absolute restrictions

NO live Neon roles/migrations/clone, Cloudflare deployment or credential changes, signing secret generation outside test-only memory, provider reads, economic/financial activation, PR auto-merge or staging/production mutation.
