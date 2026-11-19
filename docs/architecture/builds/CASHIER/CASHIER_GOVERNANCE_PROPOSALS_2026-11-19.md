# Cashier authentication: governance proposals (2026-11-19)

Status: **PROPOSALS ONLY.** Nothing here changes a rate limit, secret, credential policy, schema or deployment. Prepared under the owner directive of 2026-11-19 (section D).
Baseline: `origin/main` after the 02D and SEC-CASHIER-02C-R1 merges.

## 1. `CLIENT_ATTRIBUTION_SECRET` status

**Staging: NOT VERIFIED (BLOCKED).** No tool available to this session exposes a Worker's secret names or bindings (the Cloudflare tools return the script name and id only, and the deployed
bundle does not contain secrets). The value was never read or requested. The repository documents the rollout (`docs/STAFF-LOGIN-THROTTLING-DESIGN.md`) but not each environment's state.

What I need, names only (never values): one line per environment confirming whether `CLIENT_ATTRIBUTION_SECRET` (and optionally `CLIENT_ATTRIBUTION_SECRET_PREVIOUS`) exists on the API Worker
and on the web and cashier Workers. The owner can read this with `wrangler secret list --name <worker>` (prints names only) or in the Cloudflare dashboard. **Production** verification needs a separate authorization.

Why it matters (from `apps/api/src/middleware/rate-limit.ts`):

| | Secret NOT configured on the API | Secret configured, web Worker signs the real client address |
|---|---|---|
| Strict bucket key | the raw `cf-connecting-ip` of the caller, which for every web and cashier sign-in is the **web Worker's shared egress address** | per kind and per real source: `<scope>:<kind>:source:<ip>` and `...:subject:<account>:ip:<ip>` |
| Effect | **one** bucket of 10 requests per minute for every sign-in style call of every cashier and staff user on the platform | 10 per minute per kind per real source (a shop's router address), isolated from other sources |
| Who can lock whom out | anyone's sign-ins consume everyone's budget | one shop does not affect another |

## 2. Rate-limit capacity proposal (shared Worker egress)

Facts: `AUTH_RATE_LIMITER` is 10 requests per 60 seconds (`wrangler.toml`); `API_RATE_LIMITER` 300 per 60 seconds. Strict endpoints: staff login, cashier login, managed login, cashier session, signup,
password reset, admin re-authentication. A multi-branch managed sign-in costs **two** strict calls (login, then session); a single-branch one costs one. Refresh, logout, switch and branches are not in the strict bucket.

Model (secret NOT configured, one shared bucket): about 5 multi-branch or 10 single-branch sign-ins per minute for the whole platform. A shift change of 10 cashiers across a few shops, or a few staff
sign-ins in the same minute, produces 429s for unrelated people. With the secret configured the same load is per shop.

Proposal, in order:
1. **Provision the secret** on the web and cashier Workers first, then the API (documented procedure, rollback = remove it from the API). This is the single biggest improvement and needs no code.
2. **Verify the web Worker actually signs cashier sign-ins** (it does for the staff login path; confirm the cashier PWA's server actions use the same signer) with a staging test of 12 sign-ins from two simulated sources.
3. If a shop with many counters still hits the per-source limit: add a **dedicated cashier sign-in limiter binding** (for example 30 per minute per source, new namespace id) instead of raising the shared `AUTH_RATE_LIMITER`, keeping the per-account floor on `API_RATE_LIMITER` (300 per minute) unchanged.
4. **Never** key a strict bucket by business code or username alone (that lets anyone throttle a named business or account). The current design already avoids it; keep it that way.
5. Monitor: count `RATE_LIMITED` security events per hour per kind (audit rows already exist); alert above a small threshold.
Each step is a separate reviewed change. This proposal does not modify any limit.

## 3. Deliberate cashier-account lockout: mitigation options

Facts (`apps/api/src/cashier-accounts/credentials.ts`): 5 failed sign-ins within 15 minutes lock the account for 15 minutes; the failure count is keyed to the (business code, username) identity, not the source;
a correct password never unlocks a locked account; the administrator's credential reset clears the lock. The business code is deliberately shareable, and usernames are chosen by administrators (often guessable, for example `till1`).
Threat: anyone who knows a business code and a username can lock that cashier out at will by sending five wrong passwords, repeatedly, without any credential.

| Option | What it does | Cost / risk | Needs |
|---|---|---|---|
| A. Notify and one-click unlock | owners get a notification when an account locks; an `unlock` action (audited, re-authentication required) clears it without resetting the password | small; adds an action and a notification | cashier:manage change, UI |
| B. Progressive delay instead of a hard lock | each failure doubles a short delay (seconds to a few minutes) rather than a 15-minute block | changes the approved D-5 policy | owner ruling |
| C. Count failures per source as well | an attacker from one address cannot lock the account for everyone; requires the attribution secret to see the real source | complexity; depends on item 1 | design |
| D. Less guessable usernames | generate a suffix for usernames by default (for example `till1-k7q2`) | small usability cost; reduces probing | owner ruling |
| E. Human check after N failures | challenge before the lock engages | external dependency | design |
| F. MFA | out of scope here, see below | large | separate block |

Recommendation: **A first** (restores service in one click and makes abuse visible), then **C** after the secret is provisioned, with **D** as a cheap hardening. Option B changes the approved lockout policy and needs your ruling. No change was made.

## 4. MFA

Not implemented. The five-minute administrator re-authentication is **password-based, not MFA**, and must not be described as MFA. Keep as a separately scoped future block (scope to decide: administrators first, then optionally cashiers).

## 5. Onboarding-event retention and erasure compatibility

See `CASHIER_AUTH_02D_ONBOARDING_ATTRIBUTION.md`. Events are append-only and permanent, with RESTRICT foreign keys, so a hard delete of a customer, membership, branch or business is blocked while events exist.
No erasure flow exists today (`docs/OPERATIONS.md`), so there is no present conflict. Before any production activation:
1. decide the legal basis and retention period for attribution records;
2. decide the erasure treatment (an audited anonymisation of `customer_id` and `cashier_user_id`, or deletion under a documented basis), which needs a reviewed migration and a narrow, audited exception to the append-only guard;
3. confirm the consent wording covers the recording of branch, cashier and source.
**No production activation until these are resolved.** Staging is unaffected.

## 6. Housekeeping preserved

Synthetic staging data, the restore-drill branch `br-cold-star-au5evj0d` and the snapshots are preserved until cleanup is explicitly authorized. The four Stripe-evidence integration failures
(missing native `secure_file.node` and 0600 keyring in the development container) remain documented as environmental; no security test was weakened.
