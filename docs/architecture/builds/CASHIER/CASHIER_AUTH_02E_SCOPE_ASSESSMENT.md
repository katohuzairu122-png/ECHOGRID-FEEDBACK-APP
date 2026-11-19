# CASHIER-AUTH-02E: scope and prerequisite assessment (2026-11-19)

Status: **ASSESSMENT ONLY. 02E is not started and nothing here authorizes it.** Baseline: `main` @ `fe9c5e897ff627ec3c5e2dee5a49682875f98a5c`.

## 1. What 02E is, from the repository

The repository never defines 02E. The only mentions are scope exclusions in the 02A and 02B documents ("Not included: ... 02E full acceptance, mandatory MFA"), and the roadmap and the design decision record
(`CASHIER_AUTH_02_DESIGN_DECISION_RECORD.md`) contain no 02E section. The only evidenced meaning is therefore **"full acceptance" of the CASHIER-AUTH-02 series (02A to 02D)**.
Nothing else (MFA, new features, production activation) is attributed to it. Anything beyond acceptance would be an inference and must come from the owner.

## 2. Proposed objectives (for the owner to confirm or replace)

1. A single, repeatable acceptance suite and evidence pack covering 02A to 02D together, run on staging, and a production-readiness gate for the series.
2. Close the acceptance gaps found while assessing 02D (section 5).
3. Produce the release runbook for production activation (ordering, rollback, verification), without executing it.

## 3. Approved behavior it must verify (already decided)

D-1 to D-6 (managed identity in `users`, fixed Cashier role, business code, `cashier:manage`, credential policy, PBKDF2), 02B branch assignment, 02C branch switching with the 02C-R1 lock order, 02D append-only
onboarding attribution, the nine-route cashier allow-list, tenant isolation, and the owner-accepted 0080/0081 staging exception (sets no precedent).

## 4. Dependencies and prerequisites

| Dependency | State |
|---|---|
| `CLIENT_ATTRIBUTION_SECRET` present by name on the API, web and cashier Workers (staging, then production) | NOT VERIFIED, owner-controlled |
| Retention and erasure decision for onboarding events (D-B2 and the 02D data classes) | OPEN, owner and legal |
| Ruling on deliberate-lockout mitigation (D-5 asks for it) | OPEN |
| Production migration ledger state vs repository (0083 and earlier) | NOT INSPECTED (not authorized) |
| MFA scope | Explicitly a separate future block, not a 02E dependency |
| Branch-deletion session revocation (02D-R2) | Draft remediation PR, awaiting owner merge |

## 5. Security requirements for the series

No weakening of hashing, rate limits or the allow-list; business and branch only from the server session; no refresh token used for ordinary operations; secret values never printed; every mutation audited.

## 6. Proposed implementation blocks (each needs its own authorization)

| Block | Content | Migration |
|---|---|---|
| E1 | Acceptance harness promoted into the repository as a documented, non-production script (staging only, names-only secret checks) | none |
| E2 | Unit/integration gap closure: phone-required path with a disposable SMS fixture, email-provider regression with a test mailbox | none |
| E3 | Lockout mitigation Option A (owner notified, audited one-click unlock) if the owner selects it | none expected (reuse audit; confirm) |
| E4 | Production runbook and verification script for migrations 0082 and 0083 and the Worker deployments | none |

## 7. Owner decisions required before E-blocks

See the decision register in `CASHIER-AUTH-02D_PRODUCTION_READINESS_REPORT.md` section 11. Specifically: confirm that 02E means "full acceptance"; lockout option; secret provisioning order; retention basis.

## 8. Acceptance tests (outline)

Run the 02A to 02D suites on a fresh database and on staging: managed sign-in, lockout and reset, branch assignment and removal races, switching races, invitation issue and accept, replay, expiry boundary, tenant isolation,
purchase idempotency, redemption concurrency, branch deletion, audit completeness, four languages and RTL at 375 px.

## 9. Migration implications

None required. Production still needs 0082 and 0083 applied in order under the existing gated workflow, after a verified snapshot, and only on a separate owner directive.

## 10. Cross-workstream risks

The cashier app shares the web Worker and rate-limit namespace with staff and customer sign-in (shared-egress bucket if the attribution secret is absent); other workstreams (for example B2B, which owns 0080 and 0081) also add migrations, so the journal order must be re-confirmed before any production run;
the loyalty purchase and redemption paths are shared with the customer app.
