# LPC-17: loyalty programme release package (2026-11-27)

Distinguishes **implemented**, **locally verified**, **CI verified**, **merged** and **deployed**. Nothing in this package migrates, deploys or activates anything.

## 1. Repository baseline
`main` at the time of writing: the R7-A evidence record (#635) on top of LPC-01 to LPC-09 and the sign-up fixes. Migration journal on `main`: **108 entries (0000 to 0107)**. Applied to staging and production: **0000 to 0106 (ledger 107)**. **0107 (programme foundation) is on `main` and not applied anywhere.**

## 2. Delivered work
| Block | PR | State |
|---|---|---|
| LPC-01 to LPC-04 programme foundation, engines, screens | #624 to #627 | merged |
| Sign-up clarity and customer sign-up fix | #628 | merged |
| LPC-05 cashier hand-over API | #629 | merged |
| LPC-06 cashier earned-rewards screen | #631 | merged |
| LPC-07 customer programme card | #632 | merged |
| LPC-08 purchase reversal API | #633 | merged |
| LPC-09 reward catalogue guard | #634 | merged |
| R7-A release evidence | #635 | merged |
| LPC-10 Owner reversal interface | #636 | open, ready, CI running (updated with main by the Owner) |
| LPC-11 vocabulary (stacked on #636) | #638 | open draft, CI running |
| LPC-12/13 overlay inspection and boundaries | #637 | open draft, CI running |
| LPC-14 KWD precision, **migration 0108 (not applied)** | #639 | open draft, CI running |
| LPC-15/16/17 security review, acceptance, this package | this PR | open draft |
Hosted CI results are not final for the open PRs at the time of writing; each is reported on its PR.

## 3. Dependencies and merge order (recommended)
1. **#636** (LPC-10). It touches `reversal.service.ts`, `loyalty-account.service.ts`, `loyalty.routes.ts` and the RBAC matrix.
2. **This PR** (LPC-15/16/17). It fixes a reversal race in the same loop #636 edits, so one of the two needs a trivial merge after the other.
3. **#638** (LPC-11) after #636 (it uses #636's `purchases` message namespace).
4. **#637** (LPC-12/13) any time; independent.
5. **#639** (LPC-14) any time; independent, but it is the only PR with a migration and should merge only when the Owner is ready to schedule 0108.
GitHub requires each branch to be up to date before merging (see the note to the Owner in the session report), so after each merge the next PR needs "Update branch" and a fresh CI run (about 18 minutes).

## 4. Migration requirements
| Migration | Content | Status |
|---|---|---|
| 0107 | programme tables, guards, legacy backfill | on `main`; **not applied to staging or production**; rollback evidence exists; backfill evidence script `scripts/release/lpc-backfill-evidence.mjs` |
| 0108 | four money columns to `numeric(11,3)` | in #639 only; **not applied anywhere**; rollback refuses once a third decimal exists |
Order: restore point, ledger verification, 0107 on staging (separate authorization), staging acceptance, 0108 on staging, then production in the same order. The application is safe at either column width (it reads the scale from the catalogue).

## 5. Security review
See `LPC_15_SECURITY_REVIEW.md`: one demonstrated defect (reversal versus hand-over race), fixed with a deterministic regression test; no other defect found; the missing restricted runtime role is recorded as a separate infrastructure dependency.

## 6. Regression results (local, disposable PostgreSQL 16)
Full integration suites were green on each block before its push (most recent complete runs: 171 files, about 1,980 tests, on the LPC-09 to LPC-14 trees); API unit about 4,630 tests; web unit about 1,536 tests; tsc for both configs; eslint on touched code. One earlier full run showed unrelated Drops and Community failures while other jobs were running; it did not reproduce when run alone.

## 7. Staging acceptance requirements
See `LPC_16_FUNCTIONAL_ACCEPTANCE.md` (items that cannot be proved locally). Feature controls for Tentaship Badges, Shuffle and Drops stay off.

## 8. Deployment order (each step needs the Owner's explicit instruction)
1. Merge the PRs above (Owner). 2. Staging: restore point, 0107, then (when chosen) 0108. 3. Staging deployment of API, web and cashier. 4. Staging acceptance. 5. Production: restore point, migrations, deployment, smoke checks. 6. Production cashier: compare the deployed cashier Worker version with the API and web before deciding whether to redeploy it.
Runtime-role provisioning is independent and should precede any value-moving feature activation.

## 9. Rollback
Each migration has a rollback script under `docs/architecture/builds/TENTASHIP/rollback/`. Code rollback is redeploying the previous build; both migrations are safe for the previous code to run against (additive for 0107; widening for 0108).

## 10. Outstanding Owner decisions
Promotional overlay policy (stacking, selection, caps, budgets, reversal; six questions in `LPC_12_13_PROMOTIONAL_OVERLAYS.md`); English spelling of programme versus program; re-onboarding model after a programme switch (RW-D2 document not found); whether to apply 0107 and 0108 and when; runtime-role provisioning; recovery targets (PITR, schedules) and rotation of the previously exposed password; LP-08 (needs verified item-level evidence).

## 11. Remaining development blocks
Owner screens for overlays (blocked on policy); tier wording on the Owner screens; restricted runtime role verification at the current schema level (R7-B) and the authenticated staging Badges acceptance procedure (R7-C), both still to be done.
