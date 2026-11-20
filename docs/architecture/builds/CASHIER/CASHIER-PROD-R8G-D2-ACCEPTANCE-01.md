# CASHIER-PROD-R8G-D2-ACCEPTANCE-01: integrated acceptance record (2026-11-20)

Status: **TECHNICAL ACCEPTANCE EVIDENCE, NOT AN APPROVAL.** Nothing here is provisioned, enabled, deployed or applied to a shared database. No Owner decision is made; no legal compliance is claimed.

## 1. Repository reconciliation (and a stacking trap the Owner should know about)

- `main` = `08c61cd`: contains **#538 R8-G** (runtime role, as of its head `814ced2`) and **#540** (Community feed fix). Journal on `main`: 86 entries (last 0085).
- **#539 D2-FINAL was merged into the R8-G *branch*, after #538 had already merged into `main`.** Its content (migration 0086 and everything else) therefore sits on `security/r8g-nonowner-runtime` and is **NOT on `main`**. Cause: a stacked PR whose base is a feature branch merges into that branch, not into `main`, once the base PR has merged.
- Remedy (no force-push, nothing merged by the assistant): the D2 branch was brought up to date by merging the R8-G follow-up commits and then `origin/main`, so a normal PR to `main` carries exactly the missing work (D2-FINAL plus the R8-G follow-ups). The stale R8-G branch (which carries a squash of the old #539) can be deleted by the Owner.
- **Hosted CI does not run for a PR whose base is not `main`** (`ci-cd.yml` triggers on `pull_request` to `main` only; the 25 gate workflows likewise). A stacked PR therefore showed **zero checks**; this is why #539 never had exact-head CI. Future stacked work needs a verification PR against `main`.
- Migration numbers: no conflict (R8-G adds none; D2-FINAL is 0086; #540 adds none).

## 2. R8-G acceptance

See `CASHIER-PROD-R8G-NONOWNER-RUNTIME.md` (sections 4-6). Headline results on the final heads: full integration **1528 / 0 / 35** with the application on the owner connection **and** with ~60 suites' services on the restricted runtime login (identical); real-LOGIN adversarial suite (16 tests, 4 mutants caught); privacy isolation suite (8 tests, 3 mutants caught).

**Defect found in this block and fixed:** the provisioning script ran `ALTER ROLE ... NOSUPERUSER / NOBYPASSRLS / NOREPLICATION`, which PostgreSQL forbids for any non-superuser (even to restate a value). The production migrator (`neondb_owner`) is not a superuser, so the script would have failed in production; local suites provision as a superuser and missed it. Now fixed (create with safe attributes, then **verify** and refuse a pre-existing role with unsafe attributes) and rehearsed as a non-superuser migrator for a pre-existing role, a freshly created role, and an unsafe pre-existing role.

## 3. Migration 0086 and the chain (rehearsed)

Full chain 0000 -> 0086 as a **non-superuser migrator** (CREATEROLE/CREATEDB only): applied; a production-shaped dataset (40 customers with PII, memberships, loyalty accounts, 30 audit rows) was created at 0085 and **fingerprinted before and after 0086: identical**; ledger 87; the migrator ends ADMIN-only on the privacy roles with no schema CREATE and can neither execute the privacy functions nor assume the roles; runtime provisioning then succeeds and the verification SQL returns zero rows. Not rehearsed on Neon.

## 4. Privacy lifecycle acceptance (real PostgreSQL)

34 tests in `privacy-lifecycle` (+8 combined). Added in this block: every pre-approval state (and a rejected request) refuses anonymization and leaves the customer untouched; a forged state shortcut is refused even for a superuser; concurrent loyalty ledger writes during anonymization lose nothing (balance and every row preserved, no deadlock); two racing retention runs; a failing pair is isolated, rolled back completely, and retried by the next run. The combined suite proves from the genuine runtime LOGIN: no EXECUTE on any of the 14 privacy/erasure functions, cannot assume the owner/operator roles (nor become the real operator login), no privilege on any privacy table, cannot anonymize/un-anonymize/re-identify even though it holds UPDATE on `customers`, cannot touch audit history, and cannot give an anonymized customer a new membership, credential, session or event; the legitimate operator login (a different principal) runs the full workflow, which proves the denials are about the runtime and not a broken function. Real-world identity cannot be established by the database: verification remains an operator assertion with a unique evidence reference until the Owner approves a mechanism (R5); real erasure stays disabled (no operator, no request, no policy).

## 5. Analytics privacy: now actually used by the production route (opt-in)

Before: `summarizeWithPrivacy` existed but no route used it. Now `/analytics/onboarding` suppresses small groups when `ONBOARDING_ANALYTICS_MIN_GROUP_SIZE` is an integer >= 2; **unset keeps the exact current behaviour; an invalid value fails closed (500)**; no threshold is chosen. Verified through the real route on a 4-event business (K=5: nothing disclosed, not even the total; K=3: totals shown, the two 2-event branches folded into one bucket, no branch name leaked). The route's consumers: no web consumer found. Time and branch correlations remain governed by the unselected threshold and by day-level event times; the audit-row timing path is closed by shell anonymization, not by the threshold. Customer-facing privacy is therefore **not complete until the Owner sets the threshold (R4)**.

## 6. Data stores previously unverified (verified from code; no external system touched)

| Store | Finding | Action |
|---|---|---|
| `customer_auth_events` | `metadata` has a closed key allow-list (no phone, token, user agent possible); `subject_key` is a keyed hash used only for unknown-account events; `source_hint` is accepted by services but **no route sets it** (always NULL today); `customer_id` -> identity-free shell after anonymization | none needed; retained as security evidence (R8-C) |
| Workers logs | production uses Twilio/Resend (no console logging; Twilio error path deliberately omits phone/body). **Non-production** used a console SMS fallback that logged the **full phone number and the OTP code**; the console email fallback logs recipient + subject on staging | **Fixed for staging:** SMS recipient masked to last 4 digits (code kept readable for testers; dev unchanged; unit-tested). Email console recipient/subject on staging NOT changed (decision needed) |
| Queue `JOBS` | `SendNotificationJob` carries the **resolved recipient address and rendered subject/body**; retried 3 times then dead-lettered to a DLQ with its own consumer | **not changed.** Cloudflare queue/DLQ message retention NOT VERIFIED; erasure does not reach in-flight or dead-lettered jobs: needs a vendor-side retention check and a decision (consider carrying a customer id and resolving the address at delivery) |
| Cloudflare KV `CACHE` | velocity keys are **salted SHA-256 hashes** with an automatic `expirationTtl` | none needed |
| Notification payloads / `notifications` table | recipient and body persisted; **deleted** by the anonymization | covered |
| Feedback free text | the comment is retained; contact fields scrubbed only if the approver chooses; free text may contain personal data and cannot be reliably scrubbed | R6 |
| Community content | official posts are authored by platform admins; no customer-authored content exists in the code reviewed | none |
| Processors: Twilio, Resend, Anthropic (production feedback summaries), Stripe (business billing) | no processor-side erasure exists in this system | vendor procedure and contracts needed (R7) |
| Backups, snapshot `snap-dawn-poetry-atr06u8j`, recovery branch | hold a full copy; **not reached** by erasure | deletion/retention decision and an out-of-band erasure ledger (R1/R7) |
| Exports | none found in the code searched | NOT VERIFIED beyond that search |

## 7. Production readiness matrix (assessment only; P3 NOT authorized)

| Item | State |
|---|---|
| Current `main` | `08c61cd` (0085 on `main`; **0086 not on `main`**) |
| Pending migrations | 0080-0085 on `main`; 0086 after the D2 PR merges: bundle **0080-0086, ledger 87**; production at 0079 |
| Production snapshot / recovery drill | snapshot `snap-dawn-poetry-atr06u8j` and drill record exist but predate 0080+; re-confirm validity before P3 |
| Runtime role provisioning | **not provisioned**; script now works for a non-superuser migrator; staging rehearsal required |
| Hyperdrive configuration | existing configs use `neondb_owner`; new config **not created**; cutover not authorized |
| Privacy operator | **no members**; no operator exists |
| Retention policy | none registered; registry disabled by design |
| D1 client attribution secret | names: `CLIENT_ATTRIBUTION_SECRET` on **API, web and cashier** Workers (same value; web first, API second; optional `_PREVIOUS` for rotation). Presence **NOT VERIFIED** (values never read). Verify with `wrangler secret list --name <worker>` (names only) |
| D3 cashier lockout | pilot proposal in the P1 record (one dedicated test cashier, one branch, reset-path test, daily monitoring); not accepted |
| Owner permission provisioning | reviewed P4 script exists; not run |
| Dedicated cashier Worker / domain | not created / not attached |
| Exact-head CI | #538 head `fb88b60` 25/25 (pre-merge); final heads: see the report; stacked PRs never ran CI (section 1) |
| Release rollback | application: redeploy previous SHA; runtime-role: rebind previous Hyperdrive config; database: forward fixes (restore is last resort) |

## 8. What remains

Owner: D1, D2 text, D3, D6 (now 0080-0086), R1-R8; R5 before any real erasure; R4 before suppression has effect; R7 qualified review. Technical: staging soak of the runtime role (queue consumers, scheduled jobs, billing repositories, Chromium Community scenarios not runnable here); queue/DLQ retention and the email-console staging log; vendor-side erasure procedures; backups/recovery-branch handling.
