# Security Review — Phase 8 (Release Candidate)

Performed 2026-07-22 against `fix/verify-green-build`. Full local code
review — no infrastructure access was needed or used. 18 areas reviewed:
password hashing, JWT signing/verification, refresh-token rotation,
customer OTP, RBAC/permission enforcement, tenant isolation, impersonation,
audit logging, input validation, SQL injection, XSS, CSRF, CORS, webhook
authentication, secret storage, error-message leakage, rate limiting,
and administrative-route gating.

## Result

**0 Critical, 0 High, 2 Medium/Low fixed, 3 Low documented (not blocking).**

## Fixed in this review

### Refresh allowed a deactivated account to keep renewing its session (was: Medium)
`apps/api/src/auth/auth.service.ts` — `login()` checked `user.status === 'active'`,
but `refresh()` never loaded the user at all. Deactivating an account only
blocked new logins; an existing session kept minting fresh 15-minute access
tokens via `/auth/refresh` for the full 30-day refresh-token lifetime.

**Fix:** `refresh()` now re-checks account status on every rotation (same
pattern `requirePlatformRole` already used for platform routes). Covered by
a new test: `refresh rejects a valid token once the account is deactivated`.

### Reward redemption could be confirmed twice (was: Low, real double-fulfillment risk)
`apps/api/src/loyalty/loyalty-redemption.service.ts` +
`apps/api/src/repositories/loyalty-transaction.repository.ts` —
`confirmRedemption` read `redemptionConfirmedAt`, then wrote unconditionally
(check-then-act). Two concurrent staff scans of the same reward code could
both pass the read and both succeed, handing out the reward twice.

**Fix:** the repository update now guards `WHERE redemption_confirmed_at IS
NULL` — the actual source of truth, not a value read earlier — and the
service treats a no-op update as "already confirmed." The existing
integration test (sequential double-confirm rejected) still passes
unchanged; it couldn't have caught this race by construction (sequential,
not concurrent), which is why the fix was still needed despite that test
being green.

## Documented, not blocking (all Low)

| Finding | Where | Why it's Low, not High |
|---|---|---|
| Refresh-token-reuse detection doesn't cascade-revoke the token chain | `refresh-token.repository.ts` | Reuse of an already-rotated token is still rejected (401) — this only means a thief who uses a stolen token *before* the legitimate user keeps a valid chain rather than the whole family being killed on first detected reuse. |
| Failed auth/authz attempts aren't audit-logged | `middleware/audit.ts` — only records mutating 2xx responses with an actor | You can't reconstruct a brute-force or privilege-probing attempt from `audit_log` alone (Workers Logs still captures it). Acceptable for a tamper record of successful changes; flag for security monitoring before high-value production traffic. |
| Unbounded `limit`/`offset` on platform/loyalty list routes | `business-directory.routes.ts`, `billing-subscriptions.routes.ts`, `audit-log.routes.ts` | Behind `requirePlatformRole` already; worst case is resource pressure from an authorized admin, not a tenant-isolation or auth bypass. |

## Verified safe (no finding)

- **Password hashing** — PBKDF2-HMAC-SHA256, 600k iterations (OWASP 2026
  minimum), random salt per hash, constant-time verify.
- **JWT** — HS256 explicit (no algorithm-confusion surface), three separate
  secrets (access/refresh/customer), explicit `type` claim checks as
  defense-in-depth.
- **OTP** — crypto-random 6-digit, 10-min expiry, hashed at rest, 5-attempt
  cap, 60s cooldown, replay prevented, rate-limited (3/min/IP).
- **RBAC & tenant isolation** — every reviewed repository scopes
  tenant-owned tables by `businessId`; permission checks are resolved fresh
  per request, not cached in the token.
- **Impersonation** — platform-role gated, requires the target to hold a
  real active grant, 30-minute non-renewable token, mandatory reason,
  every action during impersonation stamped with `impersonatedBy` in the
  audit log, cannot escalate to platform routes.
- **SQL injection** — all raw `sql\`` usage is Drizzle-parameterized
  (column refs and bound values only); no string-concatenated queries found.
- **XSS** — no `dangerouslySetInnerHTML` anywhere in `apps/web`.
- **CSRF** — auth is `Authorization: Bearer` only, no cookie-based sessions,
  so CSRF doesn't apply.
- **CORS** — allow-list only, fails closed when `ALLOWED_ORIGINS` is unset,
  no wildcard.
- **Webhook auth** — Stripe signature verified via `constructEventAsync`
  before any event is processed; invalid signature → 400, no processing.
- **Secret storage** — no hardcoded secrets found repo-wide; everything
  required goes through `wrangler secret put` or Hyperdrive's out-of-band
  connection string.
- **Error leakage** — unhandled errors return a generic 500 to the client;
  stack traces are logged server-side only.
- **Admin routes** — every `platform/*.routes.ts` handler is gated behind
  `requirePlatformRole` with a fresh per-request DB status check, not just
  regular auth.

## Scope note

Spot-checked ~5 of ~25 repositories in depth for tenant scoping (feedback,
loyalty-account, loyalty-transaction, permission, refresh-token); the rest
follow the same `BaseRepository` + explicit-`businessId`-parameter pattern
and were not individually re-audited line by line. Re-verify any repository
touched by future feature work against this same standard.
