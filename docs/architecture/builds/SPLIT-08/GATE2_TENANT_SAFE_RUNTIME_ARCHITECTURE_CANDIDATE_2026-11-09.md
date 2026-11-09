# Gate 2 — Candidate Tenant-Safe Runtime Access Architecture

**Date:** 2026-11-09. **Phase:** DESIGN + OFFLINE NEGATIVE-CAPABILITY VERIFICATION ONLY. **Owner architecture ratification required.** This is not authorization to create a Neon role, change Hyperdrive, deploy, migrate default staging, or enable financial features.

## Source and observed constraints

- Authoritative repository main at branch creation: `1562ec6e4c32e3d71c5b098230d1d250f01b623f`.
- Isolated Neon recovery branch `br-wild-mode-aur6fpp8` completed the owner-authorized SQL migration rehearsal (67/67). The original staging default branch `br-bold-water-aukjlvw3` remains 45/67.
- Live Neon recovery-branch catalog: `neondb_owner` has `BYPASSRLS`, `CREATEROLE`, and `CREATEDB`. The newly added settlement, Stripe read and signed-evidence groups are `NOLOGIN`; none is a configured application-login principal.
- Ordinary operational tables such as `businesses`, `branches`, `customers`, `feedback`, `loyalty_accounts`, `surveys`, `users`, `refresh_tokens` have no RLS enabled. The protected 9 new financial/evidence relations have RLS/FORCE RLS. Catalog checks do not prove actual API request isolation.
- `apps/api/src/db/client.ts` creates a `pg.Client` from `HYPERDRIVE.connectionString`. The active Cloudflare Hyperdrive credential could not be re-attested from the current browser context; R9's `neondb_owner` observation is historical. **Fail closed rather than claiming a current Cloudflare state.**
- `apps/api/src/middleware/tenant-context.ts` verifies membership, business status and branch permissions at the application layer. `X-Business-Id` and `X-Branch-Id` remain caller-controlled selectors. PostgreSQL `echogrid.tenant_id` is likewise caller-settable and cannot independently authenticate tenant identity.
- Staff access JWT `sid` is optional for legacy and impersonation tokens. A privileged issuer must refuse sessionless and impersonated evidence until its delegation policy is separately authorized.

## Options considered

| Option | Disposition for current pooled Worker architecture | Reason |
|---|---|---|
| Continue with `neondb_owner` as Worker database login | **REJECT** | Role has BYPASSRLS and broad direct SQL/role rights; RLS is bypassable. |
| Shared application login + mutable `echogrid.tenant_id` | **REJECT as independent security boundary** | The request can spoof session settings. A GUC can be a display/scope filter only if another non-spoofable authorization check governs access. |
| Per-tenant PostgreSQL login | **DEFER** | R11 proves a disposable possibility, but one Hyperdrive configuration/pool does not provide per-request authenticated DB identity switching; credential scaling and lifecycle are not designed. |
| **Restricted shared DB broker login + database-verifiable, one-use actor/tenant assertion** | **RECOMMENDED CANDIDATE — NOT YET OWNER-APPROVED** | Fits one Hyperdrive credential while narrowing database exposure to explicitly reviewed operations. Only feasible if signer custody, durable replay checks, session revocation, authorization source and function privileges survive independent proof. |

## Proposed trust boundary (for owner ratification)

1. **Authenticated caller:** trusted staff authentication validates a signed access token, exact persisted `sid`, active user and non-impersonation. Customer JWT, public QR, background jobs and platform administration use separate explicitly approved actor types and grants, not staff assertion substitution.
2. **Trusted issuer:** a workload identity and protected signing service attest that the *caller being authorized* matches the authenticated subject/session. Caller-provided actor IDs, tenant headers and application-level permission strings are not sufficient. Protect issuance against confused deputy and compromised API credentials. A stolen shared Worker secret is not user authentication.
3. **Strict assertion:** canonical signed claims bind issuer, audience, workload, subject, exact session, tenant, branch, operation, request identity, nonce, issued/expiry time and revocation version. Use short TTL and a versioned, independently managed verification key. Key custody, verification algorithm and rotation contract require review.
4. **Narrowed database login:** distinct staging-only login with `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`, no membership in `neon_superuser` or broad group roles, no direct CRUD on tenant/financial/customer tables, no CREATE privileges, and only explicitly granted EXECUTE on audited broker functions. Never give this credential to a migrator.
5. **Database verifier/broker:** verify assertion and fresh principal/tenant/branch/operation state, atomically consume its durable nonce, then execute one fixed operation within a compatible transaction. All objects schema-qualified, pinned `search_path`, explicit privilege/role and `PUBLIC` checks. Verify signed evidence before privileged reads, not just after results return.
6. **Revocation race:** same transaction/locking or version-based mechanism must serialize session/business/membership revocation with assertion consumption. R18 proves only a limited disposable session-row pattern. R19 proves independent nonce insert atomicity, not combined live authority.
7. **Connection pooling:** cross-request and concurrent-request tests must establish no actor, business, session or GUC can leak or persist between Worker requests on a reused Hyperdrive connection. Do not rely on session state surviving pooling.
8. **Application access compatibility:** existing repositories rely on direct CRUD SQL. A broker-only role will **break those flows until routes/repositories are explicitly adapted**. Do not switch the Worker connection or remove owner access prematurely. Roll out bounded read-only endpoints first; financial, subscription and provider effects remain disabled.
9. **Operational controls:** reject absent or stale key, auth store outage, unknown action, tenant mismatch, revoked business/session, malformed claims, duplicate nonce and nonmatching branch. Safe logs include decisions and correlation IDs only; never raw JWTs, refresh tokens, keys or full customer rows.

## Mandatory independent development gates

- **B1 — Verified role/SQL privileges:** disposable PG18 restricted login; prove arbitrary SQL and all unapproved table reads/writes fail even when claiming a valid tenant.
- **B2 — Broker cryptographic verification:** issuer and verifier separate; no signer key in app client; audience/environment/actor/session/action/tenant/branch binding; key rotation and outage denial.
- **B3 — Durable nonces and revocation:** combine R18/R19 in one atomic operation, prove concurrent/rollback/replay and stale-session refusal under PostgreSQL transactions.
- **B4 — Ordinary-business flow adaptation:** tenant-safe operations for staff, branches, customer/survey/loyalty and anonymous QR separately; E2E negative tests against two businesses; explicit read and write contracts.
- **B5 — Real deployment preflight:** independently inspect Cloudflare staging Hyperdrive ID, target endpoint, DB username (not secret), environment scope; check protected GitHub staging reviewers and secret routing. Clone or disposable branch only before separate owner permission.
- **B6 — Release approval:** independent review of B1–B5, backup/restore, risk register and owner approval before actual staging runtime role, Hyperdrive or schema changes.

## Current acceptance result

`apps/api/scripts/gate2-runtime-access-choice.test.mjs` is deliberately **not an issuer or a broker**. It has fourteen static/negative-capability cases proving expected rejection *in a simulated classification model*. A green test is not cryptographic proof, real DB SQL privilege verification or runtime certification. There is no deployed signer, new role, DB migration, route, key, permission or credential.

**Next block for approval:** B1 disposable restricted-login privilege and arbitrary-SQL denial proof, preserving existing runtime.

**STATUS: DESIGN CANDIDATE RECORDED; OWNER ARCHITECTURE APPROVAL PENDING; ORIGINAL STAGING CUTOVER BLOCKED.**
