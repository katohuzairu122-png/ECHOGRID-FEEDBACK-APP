# Claude Code work queue and priority rule

Status: LIVE WORK LIST (documentation only). Owner: the repository owner assigns; Claude Code keeps this file current.
Companion roadmaps: `docs/product/ECHO_GRID_ROADMAP.md` (product), `docs/product/CHATGPT_WORK_INDEPENDENT_USABILITY_ROADMAP.md` (ChatGPT Work, WORK-UX-01).
Last updated: 2026-11-15, main `ef967a64949aed314ef5817fd8702a0c0203ac36`.

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

**STG-SEC-02 — staff login throttling (option A) and staging verification.** Code is merged and deployed to staging (#439, main
`c895edb2`, deploy run 43691373947).

| Step | State |
| --- | --- |
| Option A implemented and tested (29 adversarial tests, mutation-checked) | Done (#439) |
| Staging deployed at the merged commit | Done |
| Unauthenticated staging checks (body cap, forged/garbage attribution header, contract unchanged) | Done, passed |
| Independent security review of #439 | Started 2026-11-15 (see the completion report; findings become fixes in this item) |
| Provision `CLIENT_ATTRIBUTION_SECRET` on the web Worker, the cashier Worker, then the API | **Waiting on the owner** (cannot be set by Claude Code) |
| Staging verification of independent throttling, concurrent users, invalid attribution, account abuse, cashier regression | **Blocked** on the secret and a stable network |

Exit condition: the review findings are fixed or accepted, the secret is set, and the staging checks pass or are reported with evidence.

## 3. Awaiting the owner (nothing here starts without an answer)

| Item | Needs |
| --- | --- |
| BDPN D-18 v1.1 (remote enrollment, interest, promotions) | Owner answers to the decision register OD-1..OD-28 (`BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md` section 13), then an approved amendment. Tier 1 first: OD-1, OD-14, OD-17, OD-18, OD-24 |
| Cashier production release | Explicit production authorization; plan in `docs/CASHIER-PRODUCTION-RELEASE.md` |
| Cashier device tests | Android install, positive customer-QR scan and offline checks on a real device |
| Allowed-hosts additions (earlier decision) | Owner decision whether to remove them |
| Manager session-revoke permission; dashboard-serving activity coverage | Owner decisions |
| REWARD-02A, Features 04-06 | Owner authorization |
| PLATFORM-IDENTITY-01 | Not authorized |
| Financial activation | NO-GO |

## 4. Next, in order (queued; not started)

| # | Item | Added | Source | Notes |
| --- | --- | --- | --- | --- |
| 1 | Extend the signed-attribution throttle to signup, password-reset request/confirm and password change (they still share the per-IP bucket) | 2026-11-15 | STG-SEC-02 report | Needs owner go-ahead; same pattern and rollout order as #439 |
| 2 | Human independent review of the cashier F6/F7 code and #439 before any production use | 2026-11-15 | STG-SEC-02 report | Owner decision whether a human reviews |
| 3 | Authenticated staging validation of cashier flows and the audit attribution (C1) | 2026-11-15 | STG-SEC-02 report | Needs the secret, a staging test sign-in or authorization for synthetic data |
| 4 | Fixes from the #439 independent review | 2026-11-15 | review in progress | Becomes item 2 of section 2 when findings are in |

New items from the owner are appended here.

## 5. Owned elsewhere (not Claude Code work)

| Item | Owner | State |
| --- | --- | --- |
| WORK-UX-01 W2 feedback inbox filter persistence | ChatGPT Work | Complete (#443 merged) |
| WORK-UX-01 W1 signup watermark and simplified form builder; W3 customer Messages inline retry | ChatGPT Work | Verified still gaps on main (2026-11-15); not started by Claude Code |
| W4 integration verification | ChatGPT Work | After W1 and W3 |

## 6. Recently completed (for context)

R1/R2/R2b cashier security (#429-#431, #430); C1 audit attribution (#434); C2 broker tests (#435); C3 staff login design (#436);
C4 migration governance (#437); staging smoke fix (#438); staff login throttling option A (#439); BDPN D-18 v1.1 audit and amendment (#441);
staging migration 0072 and deploys at `ed420f78`, `58e8b98b`, `c895edb2`.
