# ECHO GRID — CUSTOMER-AUTH-01D-5

## Customer Authentication Rate Limits: Design Note, Proposed Configuration and Activation Gate

**Status: PROPOSED — DEVELOPMENT ONLY. NOT APPLIED. NOT A DECISION.**
No limiter is declared in `wrangler.toml`, no route uses these limiters, and nothing is deployed. Every number in this document is an **illustrative starting point with no traffic data behind it**. The owner sets the real budgets.

- Implements the rate-limit principles of `CUSTOMER_AUTH_01A_ARCHITECTURE_AND_SECURITY_ASSESSMENT.md` section 6.4.
- Code: `apps/api/src/customer-auth/customer-auth-rate-limit.ts` and its tests.
- **VERIFIED** = read in source or covered by a test in this change. **UNVERIFIED** = not checked.

---

## 1. What the code does

A checker (`checkCustomerAuthRateLimit`) and a Hono middleware (`customerAuthRateLimit`) that enforce several independent **dimensions** per authentication **surface**. Each surface has its own Cloudflare Rate Limiting bindings, so one surface can never spend another's budget.

| Surface             | Dimensions enforced         | Why                                                                                                  | If a limiter is missing or errors |
| ------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------- |
| `otp_request`       | phone, source, **global**   | Each success costs a real SMS. Source stops one caller rotating phones (T5). Global caps total spend | **deny**                          |
| `otp_verify`        | phone, source               | Brute force of a 6-digit code                                                                        | **deny**                          |
| `password_login`    | phone, source, phone+source | Guessing and credential stuffing (T6). Each attempt costs a 600,000-round hash                       | **deny**                          |
| `password_recovery` | phone, source               | Stricter than login in the proposal                                                                  | **deny**                          |
| `session_refresh`   | source                      | The refresh credential is 256 random bits, so there is nothing to guess                              | **allow**                         |
| `password_change`   | customer                    | Authenticated callers; stops a stolen session hammering current-password checks                      | **deny**                          |

Binding names follow `CUSTOMER_AUTH_RL_<SURFACE>_<DIMENSION>`, for example `CUSTOMER_AUTH_RL_OTP_REQUEST_PHONE`. That is 12 bindings.

### What it fixes in the current OTP limiter (all VERIFIED by tests)

| Finding (01A)                                                         | Fix                                                                                                            |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| A4: request and verify share one budget keyed by phone                | Separate bindings per surface                                                                                  |
| `phone:invalid`: every request with no usable phone shares one bucket | A dimension with nothing to key on is **skipped**. There is no shared fallback bucket, for phone or for source |
| T5: no source-based control on SMS cost                               | `source` and `global` dimensions on `otp_request`                                                              |
| Raw phone numbers used as limiter keys                                | Keys carry a SHA-256 prefix only. No phone number reaches the limiter                                          |
| A route that forgets its limiter runs unthrottled                     | Fails **closed**: a missing binding on a closed surface answers 503                                            |

### Behaviors worth knowing

- **Throttle, not lockout.** Cloudflare counts every call in a fixed window. A phone dimension that is saturated blocks that phone only until the window ends, and only while the attacker keeps sending. It can never lock an account longer than the window. T4 (an attacker keeping a victim's phone saturated) is reduced, not removed.
- **All applicable limiters are called**, not short-circuited, so every dimension's counter reflects the attempt.
- **One generic denial.** The 429 body is identical whichever dimension tripped. It never names the phone, the source or the dimension.
- **No audit row per denial.** That would let an attacker grow the events table by being throttled. Denials go to an observability hook (`onDecision`) that never receives a phone or a key.
- **Fail-open refresh.** If the refresh limiter is missing or down, refresh proceeds, so a limiter outage does not sign every customer out.

---

## 2. Proposed configuration (NOT applied)

Cloudflare allows a `period` of 10 or 60 seconds only. The existing bindings use namespace ids 1001 to 1005 (production) and 2001 to 2005 (staging) in this repository. **Whether those, or any id in the proposed range, are free in the Cloudflare account is UNVERIFIED**, and an id clash would silently share a counter with another binding. Confirm before adding.

Illustrative budgets (per 60 seconds, per key). **Invented for discussion, not derived from traffic:**

| Binding suffix                | Illustrative limit | Reasoning                                                                              |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------- |
| `OTP_REQUEST_PHONE`           | 3                  | Matches today's per-phone value. Caps harassment of one number                         |
| `OTP_REQUEST_SOURCE`          | 10                 | A household or office may share one source                                             |
| `OTP_REQUEST_GLOBAL`          | owner decision     | A platform-wide SMS spend ceiling. Needs the Twilio budget (CA-10). No number proposed |
| `OTP_VERIFY_PHONE`            | 10                 | Legitimate retries after a typo                                                        |
| `OTP_VERIFY_SOURCE`           | 30                 |                                                                                        |
| `PASSWORD_LOGIN_PHONE`        | 20                 | Looser than phone+source so one attacker cannot easily saturate a victim               |
| `PASSWORD_LOGIN_SOURCE`       | 30                 |                                                                                        |
| `PASSWORD_LOGIN_PHONE_SOURCE` | 5                  | Tight: one source guessing at one account                                              |
| `PASSWORD_RECOVERY_PHONE`     | 3                  | Recovery sends an SMS                                                                  |
| `PASSWORD_RECOVERY_SOURCE`    | 10                 |                                                                                        |
| `SESSION_REFRESH_SOURCE`      | 60                 | Loose, abuse floor only                                                                |
| `PASSWORD_CHANGE_CUSTOMER`    | 5                  |                                                                                        |

A fixed 60-second window cannot express "5 per hour". If the owner wants slower sustained limits, that needs a different mechanism (a counter in the database or a Durable Object) and is a design change, not a number change.

Shape of one entry, for review only:

```toml
# NOT APPLIED. Do not add before the owner confirms the namespace ids are free
# and the budgets are approved.
[[ratelimits]]
name = "CUSTOMER_AUTH_RL_PASSWORD_LOGIN_PHONE_SOURCE"
namespace_id = "<unique id, to be assigned>"
[ratelimits.simple]
limit = 5
period = 60
```

Staging needs its own `[[env.staging.ratelimits]]` entries with distinct ids.

---

## 3. Source identification (UNVERIFIED, open item O-E1)

The `source` dimension reads `cf-connecting-ip`. The existing code already notes that calls arriving through the web Worker may carry the web Worker's address, not the customer's, so every customer could collapse into **one** source bucket. That would make the source dimension throttle everyone together. **Whether production calls arrive that way has not been verified.**

The middleware accepts a custom `resolveSubject`. If the customer's real address must be forwarded by the web Worker, that is a trust decision: the API must only believe a forwarded address from an **authenticated** Worker-to-Worker call, otherwise any caller could spoof it and dodge the limit. This belongs to 01D-4b and needs an owner decision. Until it is settled, **do not rely on the source dimension for anything but defense in depth**.

---

## 4. What this does not cover

- No per-account lockout or progressive delay (decision D-B3 chose none). Throttling only.
- No CAPTCHA, device reputation or breached-password lookup.
- No spend alerting on SMS cost. The global `otp_request` ceiling limits damage but does not notify anyone.
- Slow, distributed guessing below every limit. Long-window limits need a different mechanism (section 2).
- The existing OTP routes are **unchanged**. They keep the single shared `OTP_RATE_LIMITER` until 01D-4b moves them onto these limiters.

---

## 5. Activation gate (all must hold before any password route is switched on)

1. Owner approves the budgets and the global SMS ceiling (CA-10).
2. Namespace ids confirmed free in the Cloudflare account, bindings added for production **and** staging.
3. The source-identification question (section 3) is decided and verified on staging with a real request path.
4. A staging test shows each surface returning 429 at its configured limit and a missing binding returning 503.
5. Hosted CI and PG18 pass on the merged code.
6. Each route that accepts a password or code applies `customerAuthRateLimit` with the right surface, with a test that the route is unreachable without it.

---

## 6. Risks and assumptions

- The tests use a fake limiter that imitates Cloudflare's fixed-window counting. **Real binding behavior, latency and counter propagation across locations are not measured here.** This repository's own comment on the existing limiter says counters are cached locally per Cloudflare location, so a caller spread across locations may exceed a nominal limit. That behavior has not been measured here.
- The numbers above are guesses. Too tight blocks legitimate households and offices, too loose gives little protection.
- Widening `AppError` to allow status 503 is a one-line type change. The error handler passes the status through unchanged.

## 7. Changelog

| Date       | Change                              |
| ---------- | ----------------------------------- |
| 2026-11-12 | First draft of 01D-5 (development). |
