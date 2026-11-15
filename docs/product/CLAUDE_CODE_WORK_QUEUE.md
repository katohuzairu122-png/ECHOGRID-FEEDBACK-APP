# Claude Code work queue and priority rule

Status: LIVE WORK LIST (documentation only). Owner: the repository owner assigns; Claude Code keeps this file current.
Companion roadmaps: `docs/product/ECHO_GRID_ROADMAP.md` (product), `docs/product/CHATGPT_WORK_INDEPENDENT_USABILITY_ROADMAP.md` (ChatGPT Work, WORK-UX-01).
Last updated: 2026-11-15 (DOCS-RECON-01), reconciled to main `eae88c702d682dec7bf4d32bf9918bc7a3f6dc7e` and re-checked against `bcd6c02f4f1faea1e2b877b4ecb395d5f456b64b` at 17:44Z (section 2b). Evidence is GitHub pull-request, workflow-run and repository state only. **Nothing in this file is a security certification.**

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
to main (#439, #445, #447, #452) and **is deployed to staging at main `eae88c7`**: Deploy staging run 43713775674 (`workflow_dispatch` on main, completed `success`
2026-11-15 12:28Z) passed every step, including the read-only staging migration-state check, the API, web and cashier Worker deploys, the staging smoke and the cashier
host-isolation smoke. Main CI run 43713469000 on the same commit also succeeded. Staging verification is **partially complete and NOT certified** (section 2a).

| Step | State |
| --- | --- |
| Staff login throttling option A (#439) | Done, merged, deployed to staging |
| Review fixes: IPv6 /64 keys, no global direct account bucket, design doc corrected (#445) | Merged and deployed to staging as part of `eae88c7` (run 43713775674). The main-push CI run for its own merge commit (43701693507) was cancelled when the next merge landed seconds later; the following main commits, including `eae88c7`, passed |
| H2: attribution-aware global API limiter; web signs every server-side API call (#447) | Merged (main CI run 43703247468 success) and deployed to staging as part of `eae88c7` |
| H3: signup, reset request/confirm and password change throttles; 120 s silent reset-email suppression (#452) | Merged (main CI run 43712183469 success) and deployed to staging as part of `eae88c7` |
| Staging deploy of current main | **Done**: run 43713775674, `success`, on `eae88c7` |
| Provision `CLIENT_ATTRIBUTION_SECRET` on the web Worker, the cashier Worker, then the API | Owner action. Secret values and Worker configuration are **not verifiable from the repository** and are not read by Claude Code |
| Staging verification (throttling from two networks, reset suppression, session expiry, cross-business isolation) | **Partially complete per external reports only; remaining gates open** (section 2a) |

Exit condition: the outstanding gates in section 2a pass or are reported with evidence, and the owner certifies. Claude Code does not certify.

### 2a. Security gates (recorded without certification)

A green CI or deploy run is **not** security verification: the staging smoke steps cover build, migration-state and host isolation only.

| Gate | State | Evidence location |
| --- | --- | --- |
| STG-SEC-04 | Partially complete (owner handoff 2026-11-15) | **External.** No STG-SEC-04 report is in this repository |
| STG-SEC-05 | Partially complete (owner handoff 2026-11-15) | **External.** No STG-SEC-05 report is in this repository |
| STG-SEC-06 | Not completed | None |
| Two-network throttling verification | Open | None |
| H3 reset suppression runtime verification | Open | None |
| Cashier session expiry and cross-business isolation | Open | None |
| Independent human security review | Open (see section 4, item 1) | None |
| Final staging certification | Open | None |

Results **reported** by the earlier session and the owner, and **not independently verified here**: H3 payload protection; web and cashier attribution supported by staging audit evidence;
invalid-attribution fallback; cashier login and role restrictions; F7 single-use selection tickets; concurrent ticket-spend protection; synthetic staging fixtures cleaned up.
These are not repeated without a specific reason. Until the STG-SEC-04/05 reports are committed to an authoritative repository location (the owner chooses it), they remain **external completion evidence**.

### 2b. Post-baseline changes (`eae88c7` to `bcd6c02`)

Main advanced by three customer-auth merges after the baseline above: #454 (14:26Z), #455 (16:35Z), #456 (17:21Z). Main CI succeeded on each (runs 43724406700, 43736314871, 43740669655). They are development-only and dormant (roadmap 2.G.2). **No staging deploy newer than run 43713775674 (`eae88c7`) appears in the workflow runs, so staging is not recorded as running them.** Migration `0073` is not recorded as applied anywhere. They do not change the security gates in 2a.

**S3 email link (#457, merged 17:59Z as `f1c04de`)** is development-only and unmounted. Its seven review findings are remediated in follow-up PR #459 (draft). **Owner decision E10 (2026-11-15):** no routine phone-OTP login after email linking; phone is a possible recovery factor but never sufficient alone. Recovery is the unauthorized future block **CUSTOMER-AUTH-01D-4b-S4**. The dormant phone-proof-only `recoverPassword` conflict is closed at the service boundary by RECOVERY-GUARD-01 (development only, open draft PR until merged); S4 remains unauthorized. See `docs/architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_S3_EMAIL_LINK.md` sections 7 and 8.

## 3. Awaiting the owner (nothing here starts without an answer)

| Item | Needs |
| --- | --- |
| BDPN D-18 v1.1 (remote enrollment, interest, promotions) | Owner answers to the decision register OD-1..OD-28 (`BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md` section 13), then an approved amendment. Tier 1 first: OD-1, OD-14, OD-17, OD-18, OD-24 |
| Cashier production release | Explicit production authorization; plan in `docs/CASHIER-PRODUCTION-RELEASE.md` |
| Cashier device tests | Android install, positive customer-QR scan and offline checks on a real device |
| Allowed-hosts additions (earlier decision) | Owner decision whether to remove them |
| Manager session-revoke permission; dashboard-serving activity coverage | Owner decisions |
| REWARD-02A, Features 04-06 | Owner authorization |
| Attribution secret on the web Worker, the cashier Worker and the API | Owner action; cannot be set or verified by Claude Code (the staging deploy itself is done, run 43713775674) |
| Where the STG-SEC-04/05 completion reports are kept | Owner names an authoritative repository location, or confirms they stay external |
| **CUSTOMER-AUTH-EMAIL-01** (owner ruling 2026-11-15: email-first customer authentication) | **Activation** (mounting routes, enabling rotating cookies, binding namespaces, applying migration `0073`, any deployment) needs separate authorization. Development PRs #454, #455 and #456 are merged and dormant (roadmap 2.G.2). Owner questions E1 to E9 remain; E3 is partly answered in code by #454 and needs the owner's recorded decision |
| PLATFORM-IDENTITY-01 | Not authorized |
| Financial activation | NO-GO |

## 4. Next, in order (queued; not started)

| # | Item | Added | Source | Notes |
| --- | --- | --- | --- | --- |
| 1 | Human independent review of the cashier F6/F7 code and the throttle and reset code (#439, #445, #447, #452) before any production use | 2026-11-15 | STG-SEC-02 reports | Owner decision whether a human reviews; all reviews so far are model reviews |
| 2 | Authenticated staging validation of cashier flows, audit attribution (C1) and the staff password-change and reset flows | 2026-11-15 | STG-SEC-02 reports | Staging is deployed at `eae88c7` (run 43713775674). Still needs the attribution-secret confirmation, a staging test sign-in or authorization for synthetic data, and owner direction on which gates to run in which session |
| 3 | Optional hardening raised by the reviews, each needing owner approval: bind the attribution header to a path or scope (L1), constant-time reset-request response (timing), lock_timeout for the reset lock | 2026-11-15 | #439 review, H3 validation | Residual risks, not defects |
| 4 | **CUSTOMER-AUTH-EMAIL-01 owner review and activation gates**: answer E1 to E9, record the decision behind #454, review the dormant S1, S2 and S2-R2 work (#454 to #456) against `CUSTOMER_AUTH_S2_R2_READINESS.md`, and decide activation | 2026-11-15 | Owner ruling (email-first approved) | Needs explicit authorization for each activation step. Depends on a working production email path (roadmap 2.E, unexplained non-delivery) and on owner decisions. Not started by Claude Code |
| 5 | Record where the STG-SEC-04/05 completion reports live (owner decision) | 2026-11-15 | DOCS-RECON-01 | Documentation only once the owner answers |

New items from the owner are appended here.

## 5. Owned elsewhere (not Claude Code work)

| Item | Owner | State |
| --- | --- | --- |
| WORK-UX-01 W2 feedback inbox filter persistence | ChatGPT Work | Complete (#443 merged) |
| WORK-UX-01 W1 signup watermark and simplified form builder (#448); W3 customer Messages inline retry (#449) | ChatGPT Work | **Merged** (2026-11-15). The earlier note that they were not started is superseded |
| W4 integration verification | ChatGPT Work | Browser acceptance infrastructure merged (#450, W4-BASELINE-01). W5 mobile touch, keyboard focus and RTL regression coverage merged (#451). ChatGPT Work's own W4/W5 sign-off is **not recorded in this repository** |

## 6. Recently completed (for context)

R1/R2/R2b cashier security (#429-#431, #430); C1 audit attribution (#434); C2 broker tests (#435); C3 staff login design (#436);
C4 migration governance (#437); staging smoke fix (#438); staff login throttling option A (#439); BDPN D-18 v1.1 audit and amendment (#441); work queue (#444); throttle review fixes (#445);
BDPN D-18 v1.1 G0 decision reconciliation, documentation only, decisions still pending (#446); H2 global API limiter (#447); H3 auth throttle coverage and reset suppression (#452);
staging migration 0072 and deploys at `ed420f78`, `58e8b98b`, `c895edb2`.

Added after the `eae88c7` baseline (merged 2026-11-15, development-only, dormant): customer-auth S1 nullable phone and challenge storage (#454, migration `0073`), S2 email HTTP contract (#455), S2-R2 rotating session transport (#456).

Added by DOCS-RECON-01 (2026-11-15): WORK-UX-01 W1 (#448), W3 (#449), W4 baseline (#450) and W5 (#451); H3 (#452); work queue updates (#444, #453); BDPN D-18 v1.1 G0 reconciliation docs (#446);
staging deploy of `eae88c7` (run 43713775674); customer email-login storage foundation (#432, migration 0072, not wired); CUSTOMER-AUTH-01 01A to 01D-5 merged and not wired (roadmap 2.G).
