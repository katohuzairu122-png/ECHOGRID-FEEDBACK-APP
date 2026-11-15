# Staff login throttling — design (SEC-CASHIER-POST-R2 C3)

Status: **Option A implemented (STG-SEC-02B), see section 9.** The text below is the original design; sections 1-8 describe the pre-implementation state. Companion tests:
`apps/api/src/auth/staff-login-throttle.adversarial.test.ts` (characterizes today's behaviour, including its weaknesses).

## 1. Today

`POST /auth/login` (and `/auth/signup`, `/auth/password-reset/request|confirm`, `/auth/password/change`) use
`rateLimit('AUTH_RATE_LIMITER')`: 10 requests per 60 s, keyed by `cf-connecting-ip` (absent header: the single key
`unknown`). There is no per-account control and no stored lockout state.

The web app calls the API Worker to Worker, so `cf-connecting-ip` is the **web Worker's egress address**, not the person's.

## 2. Findings (all reproduced by the adversarial tests)

| # | Finding | Severity | Evidence (test) |
|---|---|---|---|
| W1 | All staff signing in through the web app share one bucket: ten sign-ins a minute lock out every staff member. | High (availability) | KNOWN WEAKNESS 1 |
| W2 | Therefore anyone can lock out all staff by submitting ten wrong passwords through the public form (cheap DoS). | High | KNOWN WEAKNESS 2 |
| W3 | No per-account limit: one account can be guessed at 10/min from each of many addresses. | Medium | KNOWN WEAKNESS 3 |
| W4 | A request without `cf-connecting-ip` shares one global `unknown` bucket. | Low (edge always sets it) | KNOWN WEAKNESS (absent header) |
| W5 | Same shared-egress problem applies to signup, password-reset request/confirm and password change. | Medium | by construction (same limiter) |

What already holds (and must keep holding): header spoofing (`x-forwarded-for`, `x-real-ip`, forged attribution) cannot choose
a bucket; an over-limit request is refused before any password hashing; the 429 is identical for real and non-existent
accounts; the limiter key never contains the email or password; failed passwords count like successful ones.

## 3. Options

**A. Signed client attribution (recommended first step).** Reuse the mechanism merged in #430
(`lib/client-attribution.ts`, `CLIENT_ATTRIBUTION_SECRET`, HMAC, 60 s window). The web Worker signs the real client address on
staff auth calls. API buckets, mirroring the cashier design that already passed two independent reviews:

| Mode | Strict buckets (AUTH_RATE_LIMITER, 10/60 s) | Floor (API_RATE_LIMITER, 300/60 s) |
|---|---|---|
| Secret unset (today) | per `cf-connecting-ip` — **unchanged** | per hashed email |
| Secret set, request signed | per hashed-email + signed IP; per signed IP | per hashed email |
| Secret set, request unsigned | per `cf-connecting-ip` (direct caller); per hashed-email "direct" | per hashed email |

Effect: staff behind the web Worker stop sharing a bucket (fixes W1, W2, W5 for the web path), and one source can no longer
hold a victim's account in a strict bucket. The per-account floor (300/min) bounds distributed guessing (W3) without giving
an attacker a cheap per-account lockout. Cost: no migration, no new infrastructure, one secret already planned for the
cashier work. Risk: the same rollout hazard as the cashier change (see section 5).

**B. Challenge after failures (Cloudflare Turnstile).** Requires a Turnstile site/secret key and web changes. Best defence
against distributed guessing but adds UX friction and a third-party dependency. Owner decision. Not recommended before A.

**C. Per-account progressive delay / temporary lock stored in PostgreSQL.** Needs a migration (failed-attempt counters,
`locked_until`) and a notification policy. A hard per-account lock is itself a denial-of-service lever (an attacker locks a
named victim), so only a **delay that grows for repeated failures, never a lock**, is acceptable. Highest effort; revisit
after A shows what residual guessing remains.

**D. Edge (WAF) rate-limit rule on the web hostname.** Configuration outside the repository; sees the real client IP. Useful
as defence in depth. Cloudflare configuration is an owner action and is not changed by this work.

## 4. Recommendation

1. Implement **A** for `/auth/login` first (separate block, own review), then extend to signup / reset / change using the
   same limiter factory. Keep `rateLimit` semantics for the unset-secret case so merging is behaviour-neutral.
2. Treat **D** as parallel owner-side hardening.
3. Defer **B** and **C** until A is measured.

## 5. Rollout (identical to the cashier secret)

Provision `CLIENT_ATTRIBUTION_SECRET` on the **web Worker first**, then the API, same value, rotated together. If the API has
the secret while web requests arrive unsigned (value mismatch, rotation gap, clock skew beyond 60 s past / 5 s future),
all staff sign-ins fall into one strict direct bucket (10/min). Mitigation: alert on unsigned staff-auth traffic from the web
egress; a documented rollback is removing the secret from the API (restores today's behaviour exactly).

## 6. Test plan for the implementation block

- Re-run `staff-login-throttle.adversarial.test.ts`; the four KNOWN WEAKNESS tests are **expected to change deliberately**
  (W1–W3 flip to "not locked out"); the invariants section must stay green unchanged.
- Add both-modes limiter tests (secret unset == today, set == table above), forged/stale/wrong-secret header cases, burst
  of legitimate staff behind one egress, distributed guessing against the floor, direct attacker vs signed victim.
- Staging: two real sign-ins from different networks in one minute; ten failed attempts from one network do not block
  another; rollback drill (remove secret) restores the 10/min per-egress behaviour.

## 7. Decisions needed from the owner

1. Approve implementing option A for staff login (and the later extension to signup / reset / change).
2. Confirm the secret rollout order and who provisions it (same secret as cashier).
3. Whether to pursue option D (WAF rule) in parallel and option B (Turnstile) later.
4. Acceptance that a per-account **lock** (option C) is not wanted, only delays.

## 8. Explicitly out of scope here

No change to `auth.routes.ts`, `rate-limit.ts`, Worker configuration, secrets, or the database.

## 9. Implementation (STG-SEC-02B)

Scope: `POST /auth/login` only. Signup, password-reset request/confirm and password change keep `rateLimit('AUTH_RATE_LIMITER')`
and the shared per-IP bucket (follow-up block if wanted).

- `middleware/rate-limit.ts`: one shared builder (`attributedAuthRateLimit`) now backs both the cashier endpoints (keys unchanged,
  `cashier:...`) and `staffLoginRateLimit()` (keys `staff:login:...`). The two key spaces never overlap.
- **Secret unset (today):** identical to before for login: strict per-IP bucket on the raw `cf-connecting-ip` key (shared with the other
  staff auth endpoints, as before). Added only: a 300/min floor keyed by the hashed email on `API_RATE_LIMITER`, and an 8 KiB body cap.
  The characterization suite (`staff-login-throttle.adversarial.test.ts`) still passes unchanged in this mode; its KNOWN WEAKNESS cases
  remain true until the secret is set.
- **Secret set:** the web Worker signs the real client address on staff login/signup calls (`apps/web/src/lib/actions/auth.ts`).
  Signed: strict per-account+source and per-source buckets. Unsigned (direct callers): strict per-address and per-account "direct"
  buckets that signed traffic never touches. Floor unchanged. Fixes W1-W3 for the web path; `staff-login-throttle.option-a.test.ts`
  (29 tests) proves it, including concurrency (jittered atomic limiter), distributed guessing against a lowered floor, spoofed /
  stale / future / tampered / wrong-secret headers, email normalization, and the unchanged login response contract.
- **Session rows** record the signed client IP and user agent when attributed (the edge values otherwise).
- **Rotation:** optional `CLIENT_ATTRIBUTION_SECRET_PREVIOUS` on the API. While both are set a header signed with either verifies; a
  previous secret alone enables nothing. Procedure: (1) API: set `CLIENT_ATTRIBUTION_SECRET_PREVIOUS` = old value and
  `CLIENT_ATTRIBUTION_SECRET` = new value; (2) web Worker: set the new value; (3) after one minute remove `..._PREVIOUS` from the API.
  First-time provisioning: web Worker first, then the API. Rollback at any point: remove `CLIENT_ATTRIBUTION_SECRET` from the API
  (restores today's behaviour exactly).
- **Known hazard (pinned by a test):** with the secret on the API but the web Worker not signing (mismatch, skew over 60 s past /
  5 s future, missing client address) every web sign-in falls into the shared direct bucket (10/min). Watch for `staff:login:direct:` keys
  with the web egress address after enabling.
- **Independent review (2026-11-15) and fixes:** (H1) signed/direct keys now use the canonical IPv6 /64 (`rateLimitSource`), because
  one IPv6 host could otherwise rotate addresses and pass 300 attempts a minute against one account; (M1) the account-keyed
  "direct" strict bucket was removed: it was global across addresses, so one remote caller could hold a named account at 429 (direct
  callers are now bounded per address and by the floor). Corrections to earlier text: "identical to before" holds only relative to
  post-#439 main (the floor, the 8 KiB cap answering before any limiter, and 400 `PAYLOAD_TOO_LARGE` are new); the 29 tests prove the
  middleware in isolation, not the deployed stack.
- **H2 (global API floor), addressed in a separate change:** `api.use('*', globalApiRateLimit())` replaces the raw-address
  `rateLimit('API_RATE_LIMITER')` in `index.ts`. Secret unset: identical to before. Secret set and a VALID signed attribution: key
  `src:<client address, IPv6 as /64>`, so web users stop sharing one 300/min bucket. Unsigned, forged, stale or wrong-secret requests keep
  the legacy raw-address key (never worse than before; a web Worker that fails to sign only keeps today's shared-egress behaviour for that
  traffic). The web app now signs EVERY server-side API call (staff, customer, anonymous) via `signedAttributionHeadersSafe()`; this
  reverses the earlier "staff calls are never signed" choice, which also means staff audit rows record the signed client address once
  the secret is set. Not signed (still legacy shared-egress key): the middleware token refresh, the logout call, customer-language calls,
  `optional-qr-actions` and the cashier read helper (`cashier/auth-api.ts` line 78). Not verified: which `cf-connecting-ip` the API sees
  for web-to-API calls on Cloudflare; needs a staging check once the secret is set.
- **Residual risk:** many distinct sources (about 30+ IPv4 hosts or /64 prefixes) can exhaust the per-account floor (300/min) and block
  that account for the rest of the minute; a per-account lock was rejected as a cheaper lever (section 3, option C). An attribution
  header is not bound to a path and can be replayed for 60 s by anyone who captures it server-side (review L1, not changed).

## 10. H3: signup, password-reset request/confirm and password change (implementation)

Scope: the four endpoints that still shared the single per-IP `AUTH_RATE_LIMITER` bucket (W5). No schema, migration, secret or infrastructure change.

- **Throttle.** All four use the same builder as staff login (`attributedAuthRateLimit`, keys `staff:signup:`, `staff:reset-request:`, `staff:reset-confirm:`,
  `staff:password-change:`). Secret unset: the previous per-IP bucket on the raw address, plus the 300/min floor and the 8 KiB body cap (the same additions
  login received). Secret set: signed requests get a per-subject+source bucket and a per-source bucket (IPv6 as /64); unsigned requests get a per-address
  bucket only. **No strict account-wide bucket exists**, so no set of other sources can lock an account out. Subjects: hashed email (signup, reset request),
  hashed token (reset confirm), hashed authenticated user id (password change, mounted after `authenticate`).
- **Web.** The password-reset request and confirm server actions now send the signed attribution (signup and, via `apiFetch`, password change already did).
- **D1 reset-email suppression (120 s).** `PasswordResetTokenRepository.issueUnlessRecent` runs one transaction: per-user `pg_advisory_xact_lock`, then "is there an
  unused, uncancelled, unexpired token created in the last 120 s?". If yes it returns null: the service answers the same 202, sends no email and leaves the earlier link
  valid. If no, it cancels older outstanding tokens and inserts the new one in the same transaction. The lock is what makes it race-safe: with it removed, the
  8-connection integration test issues several tokens (verified by mutation). Uses the existing `created_at` column. A failed email send cancels the new token
  (`invalidateById`) so an immediate retry is not suppressed for a link nobody received (this slightly changes the old "token row left in place" behaviour).
  The response is identical for unknown, suppressed and sent cases. Residual: the suppressed branch does less work, so response time could in principle reveal that a
  recent request existed for an existing account (body and status do not).
- **D2.** Attribution feeds only rate-limit keys and audit/session metadata. A test asserts password change is refused (401) with a valid signed header but no token, before any
  limiter is touched, and that the user id comes from the token only.
- **Documented limits.** Users on one source share that source's strict budget (10/min per endpoint). A botnet of many sources can still exhaust the per-subject floor
  (300/min). The existing test "requesting a second reset invalidates the first link" was replaced: inside the window the first link now stays valid (owner ruling D1).
- **Rollout.** Same as section 5: secret on the web Worker first, then the API; removing it from the API restores the previous behaviour for these endpoints, except the
  suppression window, which is independent of the secret.
