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

## Owner decisions
- **CA-02 (session lifetimes), partly APPROVED 2026-11-16:** access token 15 minutes (`900`), absolute session lifetime 30 days
  (`2592000`), refresh credential rotating with a 30-day lifetime (`CUSTOMER_SESSION_REFRESH_TTL_SECONDS=2592000`, equal to the
  absolute limit as the proposal states). **Still open and needed before activation:** the idle limit
  (`CUSTOMER_SESSION_IDLE_TTL_SECONDS`, must be <= absolute) and the step-up "recent verification" window
  (`CUSTOMER_STEP_UP_WINDOW_SECONDS`). The code has no default for either.
- **CA-05 (password minimum length):** open.

## Staged plan (each its own PR, each flag-off)
1. **This stage:** the API endpoints, config resolver, delivery adapter, tests (including a real-Postgres end-to-end flow).
2. Switch the customer middleware to accept rotating sessions beside the legacy token (touches every customer route; needs the
   KS-2 legacy kill switch decision).
3. Web BFF: sign-up and sign-in screens, HttpOnly host-only cookies, origin checks, refresh and logout bridge.
4. Phone capture at registration, OTP attach (`claimVerifiedPhone`), and the verified-phone prompts.

## Guard
`customer-email-link-schema-compat.test.ts` now pins that `new CustomerSessionService(` appears in exactly one non-test file,
the flag-gated composition, that the composition is gated, and that it is mounted once.

## Stage 2 (S5-02): the customer middleware accepts rotating sessions
`customerAuthenticate` is now `createFlagAwareCustomerAuthenticate`. Flag off, it is exactly `legacyCustomerAuthenticate` (the
original verifier, unchanged). Flag on with a complete configuration, a rotating session token is proven against the database on
every request (revoking a session or suspending the customer takes effect immediately) and a legacy token is checked by the
session service's legacy rules. The connection is closed before the route handler runs. Flag on with an unusable configuration
keeps the legacy behaviour: email auth answers 503 and issues no sessions, so there is nothing to reject and no lockout.

### Readiness check before enabling the flag (read-only; run against the target database)
The session service denies a legacy token for a customer who has a credential row whose legacy cutoff is NULL (fail closed), and
for any customer with a verified login email. Count the customers this would affect:
```sql
-- customers that have a credential but no legacy cutoff (their legacy tokens would stop working)
SELECT count(*) FROM customer_credentials WHERE legacy_tokens_invalid_before IS NULL;
-- customers with a verified login email (they must use the rotating session)
SELECT count(*) FROM customer_credentials WHERE login_email_verified_at IS NOT NULL;
```
The first count must be 0 (or each row backfilled per `CUSTOMER_AUTH_01C_EXISTING_CUSTOMER_MIGRATION_PLAN.md`) before activation.
The legacy kill switch (KS-2) is still hard-wired to "legacy accepted"; making it an environment setting is an owner decision.

## Stage 3 (S5-03): web screens and the cookie bridge
**API.** `/customer-session/refresh` and `/customer-session/logout` (`customer-session-lifecycle.composition.ts`), same gate as
sign-up (generic 404 off, 503 unconfigured), Web Worker signature required, so a browser can never present a refresh credential.
The session service is now constructed in exactly three flag-gated places (guard test): email-auth, session lifecycle, middleware.

**Web.** Off unless the web Worker also has `CUSTOMER_EMAIL_AUTH_ENABLED=true`; the API has its own gate, so BOTH Workers need the
flag. Routes: `/loyalty/login/email`, `/loyalty/signup`, `/loyalty/signup/verify` (404 when off; the phone sign-in page shows a
"sign in with email" link only when on). Translated in en, fr, es, ar; errors are codes, so no message reveals whether an email is
registered.
- Credentials live only in host-only HttpOnly cookies `__Host-ff_customer_access` (expires with the 15-minute access token) and
  `__Host-ff_customer_refresh`; they never appear in a response body or page. The confirmation proof is read from the URL fragment
  and removed from the address bar at once.
- A rotating session takes precedence over the legacy cookie. When the access cookie expires, `customerApiFetch` redirects to
  `/loyalty/session/refresh` (a route handler, because cookies cannot be written while a page renders), which rotates the pair and
  returns the customer to where they were. A one-minute `ff_customer_refreshed` cookie stops a refresh/401 redirect loop. The
  handler refuses `Sec-Fetch-Site: cross-site` and only follows same-origin `next` paths.
- A refused or replayed refresh credential (401) clears the session and sends the customer to sign in. A concurrent-refresh
  conflict (409, for example two tabs refreshing at once) keeps the session: the API revokes nothing, the winning request already
  set the shared cookies, and the refresh route returns to the page once (the marker cookie bounds it, so a page that still gets a
  401 goes to sign-in and never loops). A transient failure keeps the session too.
- Logout revokes the session server-side (best effort) and ALWAYS clears every customer credential cookie on that device.
  Legacy-only customers sign out exactly as before.

**Still to do before activation:** stage 4 (phone capture at registration, OTP attach), the idle-limit and step-up values,
the Durable Object namespace and secrets, the cutoff readiness query, and a staging run of the sign-up and sign-in screens.

## Stage 4 (S5-04 / CUSTOMER-PHONE-01): phone capture, OTP attach, verified-phone prompts
**What a phone number is.** A number typed at sign-up is a *claim*, stored UNVERIFIED (`phone_verified_at` null). It proves nothing,
gates nothing, and finds nobody until the customer proves it. Verified status is stored separately and read server-side only.

**API** (signed-in customer only, `/loyalty/me/phone`; the customer comes from the session, never the request):
`GET /` (masked number + verified flag), `POST /request`, `POST /verify`. E.164 normalization (`lib/phone.ts`) accepts typed forms
(spaces, dashes, brackets, a leading `00`) and never guesses a country. A proven number becomes the customer's verified phone
through `claimVerifiedPhone`: first to verify owns it (database-enforced), a number verified elsewhere is refused (`PHONE_TAKEN`),
and unverified claims by others are released without touching their accounts.

**Provider abstraction, no live send.** `PhoneProofPort` has a local implementation (OTP rows + the SMS service's non-production
transport: development, tests, staging) and a Twilio Verify implementation (production only, the same choice the phone sign-in
already makes). Nothing in this change sends an SMS by itself, and no provider credential is assumed.

**Abuse controls** (OTP layer: 10-minute expiry, 5 attempts per code, single use, 60-second per-number cooldown; plus a per-number
rate-limit budget and the per-customer limiter). Added: at most 5 codes requested and 10 failed checks per customer per day
(`PHONE_ATTACH_LIMITED`; starting estimates for the owner to tune). Every request, success, failure and block is recorded in the
customer auth audit trail with reason codes `phone_attach_*`; no number or code is ever stored there.

**Number change.** Replacing an already verified number is refused (`PHONE_CHANGE_NOT_SUPPORTED`) until the step-up policy is
decided: swapping the verified number of an account is exactly what step-up exists to protect.

**Web.** `/loyalty/dashboard/phone` (translated in en, fr, es, ar). Joining an additional business without a verified phone now shows
a "verify my phone" prompt that returns the customer to the QR page afterwards. An optional phone field on the sign-up confirmation
screen is sent as an unverified claim.

**Not in this change.** Community join has no web screen yet (the server gate exists); a dashboard banner for unverified customers;
changing a verified number; an owner-facing abuse dashboard.
