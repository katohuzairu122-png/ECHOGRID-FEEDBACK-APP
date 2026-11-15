# Claude Code work queue and priority rule

Status: LIVE WORK LIST (documentation only). Owner: the repository owner assigns; Claude Code keeps this file current.
Companion roadmaps: `docs/product/ECHO_GRID_ROADMAP.md` (product), `docs/product/CHATGPT_WORK_INDEPENDENT_USABILITY_ROADMAP.md` (ChatGPT Work, WORK-UX-01).
Last updated: 2026-11-15, main `fa1df2c2a383491d15500287412786f606b29d92`.

## 1. Priority rule (owner instruction, 2026-11-15)

1. **Finish the current development before starting anything new.** "Finish" means done and verified, or stopped at an owner gate
   (an approval, a secret, a decision or a merge only the owner can give).
2. **New requests do not interrupt.** A new request is added to section 4 as the next item, with its date and source, and is started only
   when the current item is finished or blocked on the owner. The owner can override explicitly ("switch to X now").
3. **A blocked item is reported, not silently dropped.** When the current item waits on the owner, Claude Code says exactly what it waits
   for, then takes the first unblocked item from the queue, in order.
4. Work meant for another owner (for example ChatGPT Work) is recorded in section 5 and not done here.
5. Every block still ends with a completion report and a stop; this rule changes the order of work, not the approval gates.

## 2. Current development

**STG-SEC-02 — authentication throttling (login, recovery, signup, password change, global floor) and staging verification.** All code is merged
to main; none of #445, #447 or #452 is deployed to staging (staging is still on `c895edb2`).

| Step | State |
| --- | --- |
| Staff login throttling option A (#439) | Done, deployed to staging |
| Review fixes: IPv6 /64 keys, no global direct account bucket, design doc corrected (#445) | Done, merged, NOT deployed |
| H2: attribution-aware global API limiter; web signs every server-side API call (#447) | Done, merged, NOT deployed |
| H3: signup, reset request/confirm and password change throttles; 120 s silent reset-email suppression (#452) | Done, merged, NOT deployed |
| Staging deploy of current main | **Waiting on the owner** (explicit authorization) |
| Provision `CLIENT_ATTRIBUTION_SECRET` on the web Worker, the cashier Worker, then the API | **Waiting on the owner** (cannot be set by Claude Code) |
| Staging verification: which `cf-connecting-ip` the API sees for web calls, independent throttling, concurrent users, invalid attribution, account abuse, reset suppression, cashier regression | **Blocked** on the deploy and the secret |

Exit condition: the secret is set, staging is deployed at the merged main, and the staging checks pass or are reported with evidence.

## 3. Awaiting the owner (nothing here starts without an answer)

| Item | Needs |
| --- | --- |
| BDPN D-18 v1.1 (remote enrollment, interest, promotions) | Owner answers to the decision register OD-1..OD-28 (`BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md` section 13), then an approved amendment. Tier 1 first: OD-1, OD-14, OD-17, OD-18, OD-24 |
| Cashier production release | Explicit production authorization; plan in `docs/CASHIER-PRODUCTION-RELEASE.md` |
| Cashier device tests | Android install, positive customer-QR scan and offline checks on a real device |
| Allowed-hosts additions (earlier decision) | Owner decision whether to remove them |
| Manager session-revoke permission; dashboard-serving activity coverage | Owner decisions |
| REWARD-02A, Features 04-06 | Owner authorization |
| Staging deploy of current main (workflow_dispatch on main, expected commit + confirmation) and the attribution secret | Explicit authorization; secret set by the owner |
| PLATFORM-IDENTITY-01 | Not authorized |
| Financial activation | NO-GO |

## 4. Next, in order (queued; not started)

| # | Item | Added | Source | Notes |
| --- | --- | --- | --- | --- |
| 1 | Human independent review of the cashier F6/F7 code and the throttle and reset code (#439, #445, #447, #452) before any production use | 2026-11-15 | STG-SEC-02 reports | Owner decision whether a human reviews; all reviews so far are model reviews |
| 2 | Authenticated staging validation of cashier flows, audit attribution (C1) and the staff password-change and reset flows | 2026-11-15 | STG-SEC-02 reports | Needs the staging deploy, the secret, and a staging test sign-in or authorization for synthetic data |
| 3 | Optional hardening raised by the reviews, each needing owner approval: bind the attribution header to a path or scope (L1), constant-time reset-request response (timing), lock_timeout for the reset lock | 2026-11-15 | #439 review, H3 validation | Residual risks, not defects |

New items from the owner are appended here.

## 5. Owned elsewhere (not Claude Code work)

| Item | Owner | State |
| --- | --- | --- |
| WORK-UX-01 W2 feedback inbox filter persistence | ChatGPT Work | Complete (#443 merged) |
| WORK-UX-01 W1 signup watermark and simplified form builder; W3 customer Messages inline retry | ChatGPT Work | Verified still gaps on main (2026-11-15); not started by Claude Code |
| W4 integration verification | ChatGPT Work | After W1 and W3 |

## 6. Recently completed (for context)

R1/R2/R2b cashier security (#429-#431, #430); C1 audit attribution (#434); C2 broker tests (#435); C3 staff login design (#436);
C4 migration governance (#437); staging smoke fix (#438); staff login throttling option A (#439); BDPN D-18 v1.1 audit and amendment (#441); work queue (#444); throttle review fixes (#445);
BDPN D-18 v1.1 G0 decision reconciliation, documentation only, decisions still pending (#446); H2 global API limiter (#447); H3 auth throttle coverage and reset suppression (#452);
staging migration 0072 and deploys at `ed420f78`, `58e8b98b`, `c895edb2`.
