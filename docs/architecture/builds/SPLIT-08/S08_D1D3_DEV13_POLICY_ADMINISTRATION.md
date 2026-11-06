# S08 D1/D3-DEV-13 — Operational Read-Authorization Policy Administration

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. **One additive migration (0064).** No Stripe contact, no secrets or signing keys reachable, no ledger access. **`approval_enabled` stays `false`; nothing in this block can change it.**

## What it adds
A durable, dual-control lifecycle for *requests to change* the read-authorization policy. A request is a record only: approving it never writes the policy.

| Table / function | Purpose |
|---|---|
| `stripe_read_authorization_policy.version` (new column) | Advances by exactly 1 only when `approval_enabled` changes (trigger); cannot be set directly. |
| `stripe_read_policy_changes` | Request: expected policy version, target state, justification (`^[ -~]{1,255}$`), proposer, expiry, decision (state, decided_by, decision_ref, decided_at). States `PENDING / APPROVED / REJECTED / CANCELLED / EXPIRED`. One live (PENDING/APPROVED) request per policy version (partial unique index). |
| `stripe_read_policy_events` | Append-only audit (digest-chained records; UPDATE/DELETE/TRUNCATE denied, triggers ENABLE ALWAYS). Also records owner-side `POLICY_ROW_CREATED` / `POLICY_VALUE_CHANGED` with `session_user`. |
| `stripe_read_policy_propose / _decide / _expire` | SECURITY DEFINER, owned by NOLOGIN `stripe_read_auth_lifecycle`, fixed `search_path`, no PUBLIC EXECUTE, EXECUTE only to `stripe_read_auth_admin`. `decide` takes APPROVE / REJECT / CANCEL under a row lock; an exact repeat is idempotent, a conflicting repeat raises `READ_POLICY_DECISION_CONFLICT`. |

Database guards (independent of the API): administrator status of proposer and decider, proposer cannot decide own request, terminal states are final, expired requests cannot be approved/rejected, stale `expected_policy_version` refused at proposal and approval, immutable request fields, INSERT only as PENDING. FORCE RLS on both tables. Migration works for a non-superuser migrator (temporary lifecycle membership / schema CREATE removed afterwards; tested by M1d).

## API (extends the DEV-12 internal API; all DEV-12 controls apply: deployment flag, gateway token, no Origin, rate limit, JSON 4 KiB, no-store, session-bound administrator revalidated per call, opaque actor refs)
`GET /policy` · `POST /policy/changes` · `GET /policy/changes` (pending) · `GET /policy/changes/:id` · `POST /policy/changes/:id/approve|reject|cancel` · `GET /policy/changes/:id/audit` · `GET /policy/audit`. Every change view carries `activationPerformed: false`. There is **no** route that writes the policy and no environment flag.

## Activation boundary (`policy-activation.ts`)
Sealed contract only: `OwnerActivationAuthority` is a brand whose designated set is never populated; `evaluateActivationPreconditions` is pure; `activatePolicy` always refuses (`AUTHORITY_NOT_DESIGNATED` / `ACTIVATION_NOT_IMPLEMENTED`). It touches no database and no environment. No owner authority is invented or provisioned. Enabling remains an out-of-band owner action on the database (audited as `POLICY_VALUE_CHANGED`). A missing, corrupt or unreadable policy reports `UNKNOWN` and is treated as disabled; the DEV-12 authorization routes remain gated on `approval_enabled`. The closed read-method registry is unchanged.

## Known limits
1. The activation authority is deliberately undesignated; a future block must decide who it is.
2. A table owner / superuser can still bypass triggers (documented residual risk, as in DEV-10); the audit digest chain makes tampering detectable, not impossible.
3. Request expiry is recorded lazily (EXPIRED written on explicit `expire`), while reads derive EXPIRED for lapsed PENDING requests.
