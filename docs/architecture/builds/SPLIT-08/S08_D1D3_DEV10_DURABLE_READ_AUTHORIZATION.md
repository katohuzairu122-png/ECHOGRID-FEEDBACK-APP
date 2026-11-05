# S08 D1/D3-DEV-10 — Durable Read Authorization and Trusted Runtime Boundary

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. No Stripe contact, no real credentials, no production access, no deployment. Baseline: `main` 92fe33a (PR #229 merged). One additive migration: **0062**.

## What changed

| Area | Where | Rule |
|---|---|---|
| Durable authorization | migration 0062; `stripe_read_authorizations` (+ `_events`, `_policy`); `durable-authorization.ts` | One row per business × Stripe test account × workload × method, with state PENDING / APPROVED / REVOKED, a version, a validity window, approval evidence and revocation metadata. Missing, pending, revoked, expired, malformed, mismatched (business / account / workload / method / realm) and store-failure all deny. No in-memory fallback: no database handle yields the unavailable store. |
| Lifecycle authority | guard trigger + `stripe_read_auth_propose/approve/revoke` | Proposer, approver and revoker must be an active platform administrator (`users.platform_role = 'admin'`). Self-approval refused. Approval refused while `stripe_read_authorization_policy.approval_enabled` is false (the default; no route exists). An expired record cannot be approved or renewed; REVOKED is terminal; the version advances by exactly one; identity columns are immutable; timestamps are the server clock's. One live record per tuple (partial unique index). Row locks serialize concurrent approve / revoke. Every change writes an append-only audit event with a record digest, by trigger. The guard runs for every writer, so direct SQL cannot skip it. |
| Privileges / RLS | migration 0062 | Five NOLOGIN, non-superuser, non-BYPASSRLS roles: `stripe_read_auth_lifecycle` (internal owner of the SECURITY DEFINER functions), `_admin` (EXECUTE propose/approve/revoke), `_verifier` (EXECUTE lookup only, no table privilege), `_tenant_reader` (RLS by `echogrid.tenant_id`), `_auditor`. FORCE RLS on all three tables. Fixed `search_path`, no PUBLIC EXECUTE, column-level SELECT on `users`. DELETE / TRUNCATE / audit UPDATE denied by `ENABLE ALWAYS` triggers. Applies for a non-superuser migrator too. |
| Registry | unchanged | The four unauthorized reads and every write-shaped name still have no transport path; a database row for them authorizes nothing. Approval does not expand the capability registry. |
| Trusted runtime | `trusted-runtime.ts`, `synthetic-runtime.ts` | Authenticity is a **signed observation** from a runtime that builds its own platform-`fetch` transport. `networkSource` no longer exists. The observation binds fingerprint, workload, business, account, realm, method, API version, subject, request id, observation time, authorization id + version and contract version (`S08-STRIPE-OBSERVATION/1`), domain-separated from the settlement provenance label. The verifier checks object identity (issued in-process), the Ed25519 signature against a trusted key ring (purpose, validity window, revocation), the recomputed body fingerprint, and the expected binding. A synthetic runtime can sign only with a `SYNTHETIC_RUNTIME` key and never verifies as `REAL_NETWORK`. Missing / revoked / expired / wrong-purpose signing authority or an unavailable key ring fails closed before any request. |
| Pipeline | `read-provider.ts`, `proof-capture.ts`, `adapter.ts` | The real provider and proof capture take a runtime and a verifier, not a transport; authorization + mapping gate are rechecked inside the runtime immediately before every request; an observation that does not verify yields a denial and its body is discarded. Proof origin comes from the verified observation. |
| Settlement | unchanged | Real-origin evidence still cannot authorize consumption; evidence-kind CHECK still `MOCK_SYNTHETIC` only; DEV-03/04/05 controls and 0053–0061 untouched. |

## Known limits (honest disclosure)

1. **Key ring is trusted configuration.** Whoever controls it can trust any key. Production signing-key custody, rotation, and the runtime identity / secret provisioning are owner decisions (not made here).
2. **Process identity is per process.** `crossProcess` mode models a verifier elsewhere; there only the signature and bindings protect, and an exact copy of a valid observation verifies by design.
3. **No operational approval path.** Approval is disabled by default and there is no route, queue, cron or UI. Who may flip the switch and the approval policy are owner decisions. The lifecycle class is internal and untested against a real admin session layer.
4. **Proofs are not persisted** in the database (the in-memory proof store from DEV-09 is unchanged); only the authorization lifecycle is durable.
5. **Verifier role switch** (`set_config('role', …)`) narrows privileges for the lookup; mutating it away is behaviourally equivalent for logins that inherit the role (privilege narrowing, not a denial boundary).
6. **Equivalent mutants:** expiry is checked twice in the authorization chain (defence in depth, same reason code).
7. SDK-derived mappings stay `SDK_SCHEMA_UNPROVEN_LIVE`; nothing is TEST_MODE_VERIFIED; evidence reads therefore stay impossible by default.

## Merge order

Single PR targeting `main` (predecessor #229 is merged). Migration 0062 was the next free number at authoring time (checked against `origin/main` and open branches).
