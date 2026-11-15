# Staff login throttling — design (SEC-CASHIER-POST-R2 C3)

Status: **DESIGN ONLY. No behaviour change.** Companion tests:
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
