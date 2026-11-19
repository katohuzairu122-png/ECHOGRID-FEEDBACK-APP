# CASHIER-AUTH-02E E1: approval-ready implementation specification (2026-11-19)

Status: **SPECIFICATION ONLY. E1 is not approved and no E1 code was written.** Baseline: `main` @ `5e43e44` (PR #526 merged). Production remains NO-GO and untouched.
This is a documentation change; it does not count as implementation of 02E.

## 1. Reconciliation (verified 2026-11-19)

- `main` = `5e43e44`; PRs #520 to #526 merged; no open PRs; migration journal 84 entries, last `0083_customer_onboarding_events`. No later commits.
- Other workstreams: the most recent non-`main` branches are customer-auth and customer-phone work last touched on 2026-11-16 (no open PRs). Nothing in them overlaps this specification, which touches no schema, authorization or shared service.

## 2. What is approved, proposed, built and missing

| Item | Classification |
|---|---|
| "02E = full acceptance" | **Only evidence:** scope-exclusion lines in the 02A and 02B documents. There is no 02E section in the roadmap or the design decision record. |
| The 02E objectives, the Definition of Done and blocks E1 to E4 | **PROPOSALS** written by me in `CASHIER_AUTH_02E_SCOPE_ASSESSMENT.md`. Not approved (decision D8 is open). |
| 02A to 02D behaviour | Implemented and merged; 02D staging-accepted |
| Acceptance evidence today | Ad hoc: scripts and results kept in a session scratchpad, not in the repository; per-block integration suites exist in the repository |
| Missing verification | Repeatable repository-hosted acceptance run; phone-required path on staging; email-provider regression; live expiry on staging |
| Owner-controlled | D1 secret, D2 retention, D3 lockout, D6 production bundle, D8 definition |
| Production-release dependencies | 0080 to 0083 pending in production, no production cashier Worker, secrets, snapshot |
| Outside 02E | MFA, retention jobs, lockout policy changes, new authentication methods, any incentive on attribution |

Because E1 is a proposal, **coding is blocked at this gate.**

## 3. E1 as proposed

E1: a repository-hosted, repeatable acceptance harness for the 02A to 02D flows, usable **only against staging**, with machine-readable results. It adds no product behaviour.

Dependencies: none on D1 to D3, D6. It depends on D8 (approval of the 02E definition and of E1 itself) and on one design answer in section 8.
No conflict with 02D: it calls only existing public routes with synthetic accounts, so the nine-route cashier allow-list, server-derived context, consent, single-use and attribution rules are exercised, not changed.

## 4. Design

Location: `apps/api/scripts/acceptance/cashier-02/` (`README.md`, `run.mjs`, small helper modules). No change to `apps/api/src`, `apps/web`, schema or migrations.

Safety rules (each enforced in code and unit-tested):
1. **Staging only.** The harness refuses to start unless every target URL's host is on an explicit allow-list of staging hosts, and refuses any host that matches a production Worker name or the production domains. No override flag.
2. **No secrets in the repository or logs.** Credentials and the test mailbox access come from environment variables, are never printed, and result files are redacted (tokens, codes, passwords, emails reduced to hashes). Names-only reporting for configuration.
3. **Real flows only.** Customers are created through the real customer sign-up and OTP flow; cashiers through the administrator API. **No direct database inserts** (this keeps within the owner's rule that no direct staging customer insert is allowed without a separately authorized, independently reviewed fixture mechanism).
4. **Synthetic and labelled.** Every created record carries a run prefix; the harness never deletes anything (cleanup stays an owner decision, D7).
5. **Paced** to respect the strict authentication limiter (about 10 per minute per source), with a fixed documented pace.
6. **Read-only database verification is optional** and separate: a documented SQL file for the operator, not executed by the harness.

Scenarios (all already exercised ad hoc on 2026-11-19 against `fe9c5e8`, so this is a port, not new behaviour): managed sign-in and generic failures; lockout and administrator reset; branch assignment and removal; switch and revoke; invitation issue and accept (single and multi branch); replay, tamper and invalid; rejoin attribution; consent refusal; purchase idempotency (parallel); redemption exactly once (parallel); purchase racing a switch; cross-business refusals; reporting counts only; four languages at 375 px. Scenarios that cannot run on staging (live expiry, phone-required, email-provider) are reported as NOT RUN with the reason, never as passed.

## 5. Measurable acceptance criteria

1. `node apps/api/scripts/acceptance/cashier-02/run.mjs --env staging` exits 0 only when every runnable scenario passes, and prints the commit SHA, counts of PASS, FAIL and NOT RUN, and a result file path.
2. Run against a production host name, an unlisted host, or without the staging environment variables: exits non-zero before any request. Covered by unit tests with at least 8 host cases.
3. Result files contain no token, password, code, email or phone (tested with a redaction unit test and a grep over a sample result).
4. The unit tests run in the existing `Typecheck & Test` CI job; no hosted CI step calls staging.
5. API and web typecheck, ESLint and `wrangler deploy --dry-run` build unchanged and passing; no file under `src/` changes.
6. A full run against staging, performed by the owner or with the owner's authorization, passes the same scenarios as the manual run, and its report is attached to the completion report.

## 6. Tests

Unit: host allow-list and refusals; redaction; pacing helper; result schema; argument handling. No integration test touches a network. Security and concurrency scenarios live in the harness itself (they are the product of E1) and are not run in CI.

## 7. Migration, schema, production impact

None. No migration, no schema change, no production access, no secret created or changed. Files: about 6 new files under `scripts/acceptance/cashier-02/` plus a `package.json` script entry.

## 8. Approvals and answers needed before E1 starts

1. **D8:** confirm 02E means "full acceptance of 02A to 02D" and approve the Definition of Done (scope document section 11).
2. Approve E1 as specified (staging-only, real flows, no fixtures, no cleanup).
3. Test mailbox: which staging mailbox and delivery mechanism may the harness read OTP codes from (the earlier run used the staging email provider's inbox access)? If none is approved, customer scenarios are reported NOT RUN.
4. Confirm the staging host allow-list (the three staging Workers and their hostnames).

## 9. E1 to E4 status

| Block | State | Blocked by |
|---|---|---|
| E1 harness | Specified here, not started | D8 and the approvals in section 8 |
| E2 gap closure (phone-required fixture, email regression) | Proposal | E1, a disposable SMS fixture approval, a test mailbox |
| E3 owner-selected mitigations (for example lockout Option A) | Proposal | D3 |
| E4 production runbook (bundle, snapshot, order, rollback) | Proposal | D6, D1, D2 |

Against the proposed 02E Definition of Done (8 criteria): criterion 7 (no weakening of controls) is met; criterion 6 (no open Critical or High) is met for known findings but unconfirmed by an independent review of the full series; criteria 1, 2, 3, 4, 5 and 8 are not met. **No 02E criterion can be claimed complete.** E1 alone would complete part of criteria 1 and 2.
