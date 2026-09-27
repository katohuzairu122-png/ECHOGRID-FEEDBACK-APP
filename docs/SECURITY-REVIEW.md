# Security Review — Phase 8 (Release Candidate)

Originally performed 2026-07-22 and closed out on 2026-09-27 against `main`.
Full local code review plus API/web verification. 18 areas reviewed:
password hashing, JWT signing/verification, refresh-token rotation,
customer OTP, RBAC/permission enforcement, tenant isolation, impersonation,
audit logging, input validation, SQL injection, XSS, CSRF, CORS, webhook
authentication, secret storage, error-message leakage, rate limiting,
and administrative-route gating.

## Result

**0 Critical, 0 High, 5 Medium/Low fixed, 1 Low documented (not blocking).**

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

### Refresh-token replay did not terminate surviving sessions (was: Low)

`apps/api/src/auth/auth.service.ts` — a replayed rotated token was rejected,
but the replacement token and other sessions remained active. A replay after
the 10-second concurrent-request grace window now revokes every active
refresh token for the account before returning the generic 401. The grace
path remains non-destructive so two legitimate browser requests cannot log
each other out.

### OTP request cooldown could race across Worker isolates (was: Low)

`apps/api/src/customer-auth/customer-auth.service.ts` +
`otp_request_cooldowns` — the old latest-row read followed by insert allowed
concurrent requests to both send an SMS. A phone-keyed PostgreSQL upsert now
atomically reserves the 60-second delivery window. Successful verification
releases the reservation so legitimate reauthentication remains immediate.

### Authentication failures were absent from the durable audit trail (was: Low)

`apps/api/src/middleware/audit.ts` — 401/403 failures now create append-only
`security.authentication_failed` / `security.authorization_failed` entries.
Only method, route, error code, IP, user agent, and already-established actor/
business IDs are recorded; request bodies and credentials are never logged.

## Documented, not blocking (all Low)

| Finding                                                    | Where                                                                                    | Why it's Low, not High                                                                                                                 |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
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
  at the API boundary. The web BFF stores credentials in HTTP-only,
  Secure-in-production, SameSite=Lax cookies; cross-site POSTs do not carry
  them, and browser JavaScript cannot read them.
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
  regular auth. Platform routes also reject impersonation tokens outright,
  so an operator cannot inherit a target user's platform role or start a
  nested impersonation session.

## Scope note

Spot-checked ~5 of ~25 repositories in depth for tenant scoping (feedback,
loyalty-account, loyalty-transaction, permission, refresh-token); the rest
follow the same `BaseRepository` + explicit-`businessId`-parameter pattern
and were not individually re-audited line by line. Re-verify any repository
touched by future feature work against this same standard.

