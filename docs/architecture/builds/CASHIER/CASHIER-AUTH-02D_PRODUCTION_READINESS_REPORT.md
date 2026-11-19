# CASHIER-AUTH-02D production-readiness report (2026-11-19)

Verdict: **NO-GO for production activation** (owner-controlled blockers, section 13). A GO would not be deployment authorization either; production needs a separate explicit owner directive.
Production was not inspected, migrated, deployed or mutated for this report.

## 1. Authoritative repository identity and SHA

- The Echo Grid repository is `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`. The local checkout's remote (`katohuzairu122-png/echogrid-feedback-app`) is the same repository (GitHub names are case-insensitive).
  `origin/main` = `fe9c5e897ff627ec3c5e2dee5a49682875f98a5c` (PR #523 squash), verified by `git fetch` and by the GitHub commit listing. No later commit exists; no PR was open at the time of checking.
- `infinicus-llc/infinicus-validation` is a **different, unrelated repository**: its history is the POS2-04 workstream (migration `0231`, latest commit `7999e41`) and it does not contain the cashier commits or the 0083 journal.
  It was not modified. Echo Grid work and PRs stay in the Echo Grid repository. (The session metadata names the other repository; if that is the intended home for this work, the owner must say so.)
- Migration journal: 84 entries, last `0083_customer_onboarding_events`.

## 2. Implementation inventory (merged)

| PR | Content |
|---|---|
| #520 | 02D: `customer_onboarding_events` (migration 0083), attribution, assisted join, reporting |
| #521 | SEC-CASHIER-02C-R1: user-row lock order, atomic sign-in transaction |
| #522 | Issuer `POST /loyalty/actions/onboarding-invite` (ninth allow-listed route) |
| #523 | Cashier invite screen and customer acceptance page, four languages |
| #524 | Governance proposals and the 0080/0081 exception record |

Verified in code: the cashier allow-list is exactly nine routes (pinned by `cashier-scope.test.ts` and the web conformance test); the issuer requires a cashier session (`ONBOARDING_INVITE_CASHIER_ONLY`), takes business and branch from the verified token,
and uses the access token, not a refresh token; acceptance re-checks the cashier's live authority, branch and session inside the join transaction.

## 3. Merge and CI verification

Hosted CI/CD on the exact head `fe9c5e8` (push to main, run 44455575595): **success**. Staging migrate run 44456832520 and staging deploy run 44460353007, both on `fe9c5e8`: **success**. Earlier PR CI: #522 25/25, #523 27/27.

## 4. Staging acceptance (Gate 4, run 2026-11-19 against `fe9c5e8`)

Part 1 22/23 then the Arabic 375 px check passed on re-run (E1); part 2 12/15 on first run, **all three failures were script errors, proved against the database**, and T3 passed on a corrected re-run:
- B3/B4: the script read the wrong points field. SQL showed one purchase event and one transaction per idempotency key (five simultaneous submissions gave one), account points 35 = 20 + 10 + 10 - 5, one redemption (-5, confirmed once).
- T3: the script reused a token already invalidated by a branch switch (401). A fresh session returned 403 `CASHIER_CONTEXT_MISMATCH`.
Also verified: three attribution events with consent and audit links, `is_rejoin` recorded as a fact, a purchase racing a branch switch refused and retried on the new branch once, tenant isolation (cross-business issue and report refused), report holds counts only, zero orphan live sessions.
Staging metadata matches the repository: 84 migrations applied, the event table has 7 RESTRICT foreign keys, 5 CHECKs, 7 indexes and both guard triggers enabled (always).

## 5. Acceptance coverage that was missing

| Scenario | Result |
|---|---|
| Live invitation expiry on staging | NOT RUN live (no secret access, by design). Covered by an integration test (expired token refused) **and a new deterministic unit test**: valid at 10:09:59, refused at exactly 10:10:00 and after, no grace period, a token from the future is refused. |
| Phone-verification-required path | Covered by real-PostgreSQL integration tests (additional business without a verified phone refused and leaves no event; with a verified phone attributed to its own branch). NOT RUN on staging (no SMS fixture). |
| Staff and customer email regression | Covered by existing suites (staff and customer auth, `customer-email-auth.spec.ts`, managed-cashier). Staging email delivery regression NOT RUN here (no provider access in this task). |

## 6. Security findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| R2-1 | Low | `BranchService.deleteBranch` left cashier session rows live until refresh or expiry. Not exploitable: tenant context and refresh both re-read the branch, so a deleted-branch session performs nothing and cannot refresh. A concurrent switch could also mint a session row on a branch being deleted (same class as 02C-R1). | **Corrected** in draft PR (section 12): the deletion locks affected users in the 02C-R1 order, deletes and revokes in one transaction. 4 tests, 3 failed before the fix. |
| R2-2 | Medium (availability) | `CLIENT_ATTRIBUTION_SECRET` unverified. Without it every sign-in on the platform shares one bucket of 10 per minute (the web Worker's egress address). This degrades availability, not authentication: wrong credentials still fail, and nothing fails open to access. | Owner blocker; cannot be verified from this environment (names only). |
| R2-3 | Medium | Deliberate lockout (5 failures lock a cashier for 15 minutes; the correct password does not unlock). Anyone who knows the shareable business code and a username can lock that cashier out. It locks one account, not unrelated cashiers, unless they iterate usernames. The approved D-5 asks for mitigation of deliberate-lockout abuse and only rate limits exist. | Not a coding defect: needs an owner ruling (options in the governance proposals). No change made. |
| R2-4 | Low | L-1: the invitation is signed with the same secret as access tokens. Separate `type` claim prevents cross-use; a leak of that secret is already catastrophic. Separation would only add blast-radius isolation. | Accepted; separate key is optional hardening. |
| R2-5 | Low | The cashier host serves customer pages (`/loyalty/*`). Staff surfaces are redirected and server actions are refused off the cashier host; customer pages are public routes whose resources need a customer token, and customer and cashier cookies and tokens are distinct. No authorization or isolation defect found; it is a hygiene and phishing-surface issue. The invitation link is built from `WEB_BASE_URL`, not the cashier host. | Optional hardening decision. |
| R2-6 | Info | MFA: D-5 states MFA is a separate future block and is NOT implemented. It is not a requirement of 02D. The five-minute reauthentication is password-based and is not MFA. | Recorded; not a 02D blocker. |
| R2-7 | Low | Attribution abuse (repeat invitations, synthetic or colluding customers): each credit needs a real authenticated customer with explicit consent and one single-use invitation; invitations are rate-limited per cashier and audited. No incentive depends on attribution today. If incentives are ever attached, thresholds and anti-abuse rules need approved requirements first. | No thresholds introduced. |

## 7. Retention and erasure

No retention or erasure rule is approved for 02D data. The append-only events with RESTRICT keys block hard deletes of the customer, cashier, branch or business while events exist. Decision record, data classes and options:
`CASHIER_AUTH_02D_RETENTION_DECISION_RECORD.md`. **Production blocker until decided.**

## 8. Secret configuration verification

`CLIENT_ATTRIBUTION_SECRET` (and `_PREVIOUS`): **NOT VERIFIED**. No tool available here lists Worker secret names. No value was read. Needed from the owner, names only: presence on the API, web and cashier Workers for staging and production
(`wrangler secret list --name <worker>`). The code was inspected: absent means the shared legacy bucket (no fail-open to access); configured means per-source buckets with signed attribution, and unsigned callers are treated as direct callers. Roll the secret out to the web and cashier Workers first, then the API; rollback is removing it from the API.

## 9. Migration 0083 compatibility

Additive: one new table, one guard function, two triggers. Older application versions never touch it. The guard rejects UPDATE, DELETE and TRUNCATE, so **rollback is a DROP TABLE of the whole object, which would destroy event history**; take a snapshot first and treat 0083 as forward-only once events exist.
Deployment order: migration, then API, then web. A new web deployed before the API would call routes that do not exist. Production ledger state was not inspected (not authorized); re-confirm the journal order (0082, 0083) before any production run.
Staging evidence: pre-migration snapshot `snap-mute-resonance-aur27p2o` exists; 84 migrations applied; the guard triggers are enabled.

## 10. Operational risks and rollback

Roll the web back independently of the API (the interface only calls the issuer and preview routes); disabling the feature is removing the Invite tab by redeploying the previous web build, because the issuer is cashier-only and harmless unused.
Shared-bucket 429s during shift changes if the attribution secret is absent. No MFA. No retention purge. Four Stripe-evidence integration failures are environmental (section 14) and unrelated.

## 11. Required owner decisions (register)

| # | Decision | Needed by |
|---|---|---|
| 1 | Confirm `CLIENT_ATTRIBUTION_SECRET` presence by name (staging, production) and approve rollout order | Before production |
| 2 | Retention basis and period, erasure treatment (options A to D) | Before production |
| 3 | Lockout mitigation: Option A, C, D, or B (policy change) | Before production |
| 4 | Merge the 02D-R2 draft PR (branch deletion revokes sessions) | Before production |
| 5 | Optional: keep customer pages off the cashier host; separate invitation signing key | Optional |
| 6 | Production-readiness gate: separate directive to inspect the production ledger and to deploy | Before production |
| 7 | Cleanup authorization for synthetic staging data and drill branches | Housekeeping |
| 8 | Which repository this work belongs in (Echo Grid vs `infinicus-llc/infinicus-validation`) | Now |
| 9 | Define what 02E is (the repository only says "full acceptance") | Before 02E |

## 12. Remediation PRs

Draft PR for `fix/sec-cashier-02d-r2-branch-delete-session-revocation` (no migration, no schema change, not merged). Exact-head CI result: see the PR; recorded in the completion report.

## 13. Production GO/NO-GO

**NO-GO.** Blocking: decision 1 (secret unverified), decision 2 (retention and erasure), decision 3 (D-5 lockout mitigation not realized), decision 4 (merge R2), and a separate directive for any production action.
Not blocking: MFA, the optional hardening items, the Stripe environmental failures.

## 14. Test evidence (this task)

See the completion report for exact counts. Stripe failures: four forensic-reader and export tests fail with `Cannot find module './build/Release/secure_file.node'` (native module not built) and the 0600 keyring check in this container;
they belong to the SPLIT-07 Stripe evidence package, do not execute any 02D code path, and have no bearing on 02D readiness. They should be confirmed green in hosted CI (the hosted run on `fe9c5e8` succeeded).

## 15. Residual risks

Lockout abuse; shared-bucket availability if the secret is absent; no retention or erasure path; the invitation key shared with access tokens; the customer pages on the cashier host; attribution has no anti-abuse thresholds because no incentive uses it.

## 16. Evidence references

Merge commits and CI runs above; `CASHIER_AUTH_02D_ONBOARDING_ATTRIBUTION.md`; `SEC_CASHIER_02C_R1_REVOCATION_RACE.md`; `CASHIER_GOVERNANCE_PROPOSALS_2026-11-19.md`; `CASHIER_AUTH_02D_RETENTION_DECISION_RECORD.md`; `CASHIER_AUTH_02E_SCOPE_ASSESSMENT.md`;
`cashier-branch-delete-revocation.integration.test.ts`; `onboarding-attribution.test.ts` (expiry boundary).
