# Features 04 to 06: integration review (design only)

**Status: DESIGN ONLY. No code, schema, migration, authentication configuration, feature activation or deployment is authorized by this document. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged.**
Baseline: `main` `de997da6` (2026-11-14). Covers `CASHIER_PWA_01_DESIGN.md`, `TIMEZONE_01_DESIGN.md` and `REWARD_CONFIG_01_DESIGN.md`.

## 1. Shared dependencies

| Needs                            | From             | Why                                                                                                                                                                        |
| -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active program resolution        | REWARD-CONFIG-01 | The cashier purchase screen and API must record a purchase against the business's one active program                                                                       |
| Business-local time              | TIMEZONE-01      | Streaks (LP-05), off-peak (LP-06), daily limits, cashier activity display and reports                                                                                      |
| Scope-limited cashier token      | CASHIER-PWA-01   | Keeps counter actions apart from configuration, so a cashier cannot touch program settings                                                                                 |
| Exact decimals and KWD precision | REWARD-02A       | Every monetary rule in the programs; also the cashier amount entry                                                                                                         |
| Migration discipline             | Release process  | Each new migration needs authorization (staging first) and the Gate 2 journal re-pin; numbers must be re-verified because other PRs may add migrations (next after `0070`) |

The three domains stay separate: no shared tables, and each ships behind its own blocks.

## 2. Contradictions found and how each is handled

| #   | Conflict                                                                                                                                   | Resolution in the designs                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The owner's words "reward types need their own settings and be chosen at registration" mix two things: programs (LP) and reward types (RW) | Read as program types; reward types stay in the catalogue (confirm, REWARD-CONFIG-01 decision 6)                                   |
| 2   | "Choose at registration" versus businesses that earn points today with no choice                                                           | Legacy backfill keeps current earning; new businesses choose or "Configure later" with its behavior left to the owner (decision 1) |
| 3   | Branch timezone (non-null, default UTC) versus a single business timezone                                                                  | Business timezone governs; branch value informational; owner decision                                                              |
| 4   | Server day boundaries are UTC (reward daily limit, notification cap, analytics) but a business expects its local day                       | Adopt a single local-day helper; keep billing quantities (monthly allowance) UTC unless decided otherwise                          |
| 5   | Cashier app cookies versus impersonation cookies (`ff_admin_*`, `ff_impersonating`)                                                        | Cashier app refuses sessions while impersonating; impersonation never opens the cashier app                                        |
| 6   | Program configuration permission (`rewards:manage`) versus owner-only switching (RW-D2)                                                    | Both checks apply: switching is owner-only on top of the permission                                                                |
| 7   | Existing manifest scope `/` versus a cashier manifest                                                                                      | Cashier manifest scope `/cashier/` with its own id; the main manifest is unchanged                                                 |
| 8   | Gate 2 database checks pin the exact number of migrations                                                                                  | Each block that adds a migration includes the re-pin, as in 0067 to 0070                                                           |
| 9   | The WEB-1102 restriction (no new Web feature to production until certified) versus Web-heavy features                                      | All blocks are development only; none is released until Block 0 is certified and the owner authorizes releases                     |

## 3. Recommended order

1. **T1** (timezone validation, no migration) and **C2** (cashier token scope and allow-list, no UI): small, additive, low risk.
2. **P0** REWARD-02A (money and KWD): prerequisite for every monetary program.
3. **P1 to P3** (program tables, backfill, selector, LP-03 page) and **T2 to T4** (timezone UI, columns).
4. **C3 to C7** (cashier login, pages, install, revoke, activity).
5. **P4, P5, P6**, then **T5**, then **P7** programs that need local time.
   Rationale: smallest risk first, financial prerequisite before money features, and each step independently verifiable.

## 4. Cross-feature requirements

- Cashier purchase verification uses the active program; with no active program it records the purchase and awards nothing, and shows the owner's setup state.
- Rewards and eligibility that depend on local time use the business timezone only.
- Customer balances and progress come from the same ledger and progress tables in the cashier app and the customer app, so they cannot disagree.
- Tenant isolation, consent and the financial boundary are unchanged; Community Points stay separate (RW-D8).

## 5. Self-review checklist

- Every document has the twelve required sections.
- No document claims an implementation exists that does not; unbuilt items are labelled NOT IMPLEMENTED, BLOCKED or UNKNOWN.
- Verified facts cite the source (session cookies, manifest, service worker, refresh tokens, timezone columns and validation, UTC day boundaries, program-less settings, D-C1 permissions).
- Unresolved items are listed as owner decisions, not decided.
- UNKNOWN items still to verify before build: installed-PWA cookie behavior per platform, timezone validation on the Workers runtime, database session timezone, the program re-onboarding document, the LP-01 entitlement mechanism, refresh-token binding columns.

## 6. Consolidated open owner decisions

Cashier: origin choice, session lifetimes, who may use the app, PIN or device registration, recent-activity scope. Timezone: branch versus business zone, local day for limits and reports, monthly allowance in UTC, customer time display, banner for existing businesses. Programs: "configure later" behavior, LP-01 entitlement, re-onboarding model reference and stamp expiry and reset, stacking configuration owner, draft alongside active, terminology confirmation.

## 7. Readiness verdict

**Not ready to implement.** The designs are complete for owner review, but the decisions above are unresolved and several prerequisites are not met (REWARD-02A, WEB-1102 certification, owner authorization for each block and each migration).
