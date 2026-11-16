# CUSTOMER-AUTH-S5-01: email registration and login API (Option A, stage 1 of 4)

Status: implemented in development, **OFF by default**, nothing activated anywhere. Owner chose Option A (the documented
design: rotating sessions, no reuse of the legacy 90-day token path).

## What exists
- `POST /customer-auth/email/register/request`, `/email/register/complete`, `/email/login`, mounted by
  `customer-email-auth.composition.ts`. Every path is a generic 404 unless `CUSTOMER_EMAIL_AUTH_ENABLED` is exactly `true`.
  With the flag on, any missing or unusable setting answers a generic 503 (no default, no fallback, no value echoed).
- Only the Web Worker can call them: every request must carry the Web Worker's signed attribution
  (`CLIENT_ATTRIBUTION_SECRET`); unsigned or direct requests are denied. Rate limits use the shared Durable Object limiter.
- Registration: a proof is emailed as a URL fragment (`/signup/verify#c=<challengeId>.<proof>`), consumed once, and creates an
  email-only customer (no phone) plus a verified-email credential atomically. A request for an already-registered email
  returns the same 202 and delivers nothing (no account enumeration).
- Login: `loginWithVerifiedEmailPassword` issues a rotating session. The API returns the credentials to the Web Worker only
  (`Cache-Control: no-store`); the browser must never receive them in a body (stage 3: HttpOnly cookies).
- The legacy `customerAuthenticate` path and the 90-day token are untouched. Existing customers are not affected.

## Settings required to activate (none is created by the code)
| Setting | Notes |
|---|---|
| `CUSTOMER_EMAIL_AUTH_ENABLED` | exactly `"true"` |
| `CUSTOMER_EMAIL_AUTH_HMAC_SECRET` | dedicated, >= 32 bytes, not reused by any other binding |
| `CUSTOMER_SESSION_SIGNING_SECRET` | dedicated, >= 32 bytes, distinct from `CUSTOMER_JWT_SECRET` |
| `CUSTOMER_SESSION_ACCESS_TTL_SECONDS`, `_REFRESH_TTL_SECONDS`, `_ABSOLUTE_TTL_SECONDS`, `_IDLE_TTL_SECONDS`, `CUSTOMER_STEP_UP_WINDOW_SECONDS` | **owner decision CA-02**, no defaults. Must satisfy access < refresh <= absolute and idle <= absolute |
| `CUSTOMER_PASSWORD_MIN_LENGTH` | **owner decision CA-05**, no default |
| `CUSTOMER_AUTH_RATE_LIMIT` | Durable Object namespace bound to `CustomerEmailRateLimit` (class is now exported from the Worker entry; the binding and its migration are infrastructure to provision at activation review) |
| `CLIENT_ATTRIBUTION_SECRET`, `WEB_BASE_URL`, `RESEND_*`, `HYPERDRIVE`, `PASSWORD_HASHER` | existing bindings |

CA-02 is still a PROPOSAL in `CUSTOMER_AUTH_01A` (15 minutes access, 30 days absolute, rotating refresh). It needs owner approval
before any value is set.

## Staged plan (each its own PR, each flag-off)
1. **This stage:** the API endpoints, config resolver, delivery adapter, tests (including a real-Postgres end-to-end flow).
2. Switch the customer middleware to accept rotating sessions beside the legacy token (touches every customer route; needs the
   KS-2 legacy kill switch decision).
3. Web BFF: sign-up and sign-in screens, HttpOnly host-only cookies, origin checks, refresh and logout bridge.
4. Phone capture at registration, OTP attach (`claimVerifiedPhone`), and the verified-phone prompts.

## Guard
`customer-email-link-schema-compat.test.ts` now pins that `new CustomerSessionService(` appears in exactly one non-test file,
the flag-gated composition, that the composition is gated, and that it is mounted once.
