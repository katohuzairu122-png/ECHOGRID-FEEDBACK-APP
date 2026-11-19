# CASHIER-AUTH-02E E2: live acceptance gap closure (2026-11-19)

Status: **development complete when merged; live staging acceptance NOT performed and BLOCKED by owner approvals.** Baseline: `main` @ `c61380f` (E1, PR #528). ADR: `CASHIER_AUTH_02E_ADR_001_SCOPE_DIRECTION.md` (E2 is acceptance automation, not a feature phase).

## Scope reconciliation

Existing before E2: the E1 harness (guard, redaction, pacing, mailbox contract with a six digit code, results, 14 scenarios), the Playwright tier in `apps/web/e2e` (with a production-host guard for remote runs), and the real customer sign-up pages.
Finding that shaped E2-B: the real customer sign-up sends an **email confirmation link**, not a six digit code (a code exists only for phone sign-in by SMS). The E1 mailbox contract was therefore extended, not replaced.

| Component | Implemented | Verified how | Not verified |
|---|---|---|---|
| E2-A live provisioner | yes (provisioner + browser driver) | unit tests (fake driver); mock-backed run through the real application | any real sign-up (needs mailbox) |
| E2-B verification mailbox | yes (contract, no live adapter) | unit tests (fixture source) | any real mailbox |
| E2-C browser tier | yes (B01 to B09, local fixture, targets guard) | **real browser against a real local stack: 10/10**; a mutation run (invalid customer sessions) failed B04, B05 and B06 as it must | staging; the real sign-up; Arabic text of every screen |
| E2-D integration | yes (explicit `requires`, S15, ingestion with mode check, CLI wiring) | unit and integration tests | live run |

## What a "pass" means

- Browser results carry the mode they were gathered in. A **local** pass is reported NOT RUN in a **staging** run, by construction.
- Local customers are database fixtures with a locally minted session; this is stated in the spec, the fixture and the README. The real sign-up and OTP flow has not been exercised anywhere.
- A scenario run through a fixture mailbox or fake driver is labelled MOCK-BACKED in the test name and is not counted as executed live.

## Live execution dependencies (all owner-controlled, none resolved)

1. Approval of the three staging hostnames recorded in `staging-targets.json` (`approved`, `approvedBy`, `approvedAt`).
2. An approved test mailbox: provider and adapter, approved recipient domain(s), credentials supplied through the environment (names to be agreed), and an adapter implementation for that provider (none ships).
3. Authorization to create synthetic customers (`customerProvisioning.approved`).
4. Staging business credentials for two owners in environment variables, with at least three branches in business A and one in business B.
5. Explicit live-execution authorization (separate directive). Phone-verified scenarios additionally need a real SMS code and stay NOT RUN.

## Owner decisions still open (not touched by E2)

D1 attribution secret · D2 retention and erasure · D3 deliberate lockout · D6 production release bundle · staging-host approval · test mailbox · synthetic-identity authorization · live execution authorization.

## E3 and E4 dependencies

E3 needs D3. E4 needs D1, D2, D6. Neither is started.

## Completion assessment against the proposed 02E Definition of Done

1. Repeatable acceptance run in the repository: **met for local and CI; not met for staging** (blocked).
2. Covers the matrix incl. phone-required, email regression, languages: **partly** (browser tier and returning customer added; phone-verified, email provider and live expiry remain NOT RUN).
3. Owner decisions D1 to D7 answered: **not met**.
4. Production runbook: **not met** (E4).
5. Attribution secret confirmed by name: **not met**.
6. No open Critical or High: **unchanged, no independent whole-series review**.
7. No weakening of controls: **met** (verified by the existing integration suites).
8. Final GO/NO-GO report: **not met**.
