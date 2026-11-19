# SEC-CASHIER-02C-R1: branch switching versus assignment revocation race

Status: **IMPLEMENTED, development only.** No schema change, no migration, not deployed. Baseline: `origin/main` @ `ecf36df4f5d09f37989eb691c554f24c21a46f7a` (02A, 02B, 02C, 02D merged).

## Defect

A managed cashier could end up with a **live session bound to a branch whose assignment had already been removed** when a branch switch (or a sign-in that chose the branch)
raced the administrator's removal. The same class existed for **disabling an account** and **resetting its credential** racing a switch, and for **revoke-sessions** racing any issuance.

## Root cause (established from the code and reproduced deterministically)

Session issuance and administrator revocation were ordered by nothing that covered the window that mattered.

1. The administrator (`setBranchAssignments`) locks the `users` row `FOR UPDATE`, soft-deletes the branch grant, then revokes the refresh rows bound to the removed branch.
2. The issuers (`switchBranch`, and the two sign-in paths through `openSession`) read eligibility (`eligibleChoices`) **without taking any lock**, and only later insert the new
   `refresh_tokens` row. That insert takes an implicit `FOR KEY SHARE` lock on the `users` row (the foreign key), which protects only the span from insert to commit.
3. Interleaving that produced the orphan: issuer reads eligibility (branch still granted) -> administrator removes the grant and commits (its revoke finds no row for that
   branch yet) -> issuer inserts the row on the removed branch and commits.
4. Disable, credential reset and revoke-sessions made it worse: reset and disable use a plain `UPDATE users` (`FOR NO KEY UPDATE`), which does **not** conflict with the
   foreign key's `KEY SHARE`, and revoke-sessions took no `users` lock at all. Under READ COMMITTED their `UPDATE refresh_tokens` cannot see a row an in-flight issuer has
   inserted but not committed, so that row survived with the account disabled or its credential reset.
5. Refresh is **not** exposed: its rotation is a conditional update of the old row; the administrator's revoke hits that row first, so the rotation fails and the new row is revoked
   (proved by the tests, which pass before and after).

What the orphan could and could not do: every request re-checks live grants in `resolveTenantContext`, so a token bound to a removed branch is refused there (`BRANCH_ACCESS_DENIED`);
the unrevoked row was a **latent live session** (accepted by the session-liveness check, resurrectable if the branch was assigned again, and issued credentials that the
removal was supposed to prevent), not an open door to serving. The correction removes the orphan itself rather than relying on the request-time check.

## Correction: one lock, one order

`UserRepository.lockForSessionIssue(userId)` takes `SELECT ... FOR SHARE` on the user row, held until the transaction ends.

| Path | Before | After |
|---|---|---|
| Branch switch | no user lock; eligibility read unlocked | user row `FOR SHARE` **first**, then the 02C session-row lock, then eligibility, insert, rotate, revoke, audit (one transaction, unchanged) |
| Sign-in (single branch, or ticket + chosen branch) | autocommit; eligibility computed earlier | one transaction: user row `FOR SHARE`, account active, authority re-checked, then insert. The slow password hashing stays outside it |
| Refresh | unchanged (protected by atomic rotation) | unchanged |
| Admin branch removal | user row `FOR UPDATE` | unchanged |
| Admin disable / revoke / credential reset | plain `UPDATE users` | unchanged; this now conflicts with the issuers' `FOR SHARE` |
| Admin revoke-sessions | no user lock | user row `FOR UPDATE` first |

Why it is correct. `FOR SHARE` conflicts with `FOR UPDATE` and `FOR NO KEY UPDATE` and not with other `FOR SHARE`. So an issuer and a revoker can only run one after the other:

- **Outcome A, issuer first.** The issuer holds the share lock until it commits; the revoker waits; once it runs, its statements see the committed new row and revoke it.
- **Outcome B, revoker first.** The revoker holds the exclusive lock; the issuer waits at the first statement (before reading eligibility), then reads the committed state, finds the
  authority gone and refuses, issuing no credential. A refused switch leaves the valid session exactly as it was.
- No third outcome exists: the authority read and the insert both happen under the lock that excludes a concurrent revoker.

Lock order is `users` row, then session rows, on every path; administrators take the `users` row before touching any session row. A waiter therefore never holds a lock the
other needs, so there is no cycle (the interleavings, loops and 20+ rounds finished with no deadlock). Concurrent issuers of different cashiers, or of one cashier, share the lock and are not serialised.

Not changed: refresh-token rotation, replay containment (including across a switch), single-use selection tickets, session family isolation, business/branch claims,
`CASHIER_CONTEXT_MISMATCH`, the eight-route allow-list, credential-reset revocation, migration 0083, any schema.

## Tests (`test/integration/cashier-revocation-race.integration.test.ts`, real PostgreSQL, database state asserted)

Deterministic pausing: a second connection holds `LOCK TABLE audit_log`, which parks each transaction at its last write (the audit row) with everything else done and uncommitted.
Before the fix 9 of 21 fail (the switch and sign-in issued credentials after the removal committed; reset and disable left a live session; the 24-round loops found orphans).
After the fix 21 of 21 pass, repeatedly. Covered: switch first and removal first, refresh and sign-in against removal, reset and disable against a switch, repeated and concurrent
switching, multiple sessions of one cashier, repeated removal, removal then re-assignment (no resurrection), cross-business substitution, revoked-token reuse, rollback after an injected
failure in the removal and in the switch, and the unaffected branch's session surviving.

## Out of scope / follow-up

The invitation issuer for 02D is **not** implemented here. Recommended for a separate authorization: option A, `POST /loyalty/actions/onboarding-invite`, added explicitly to the cashier
allow-list with access-token authentication, current `loyalty:serve`, business and branch from the session, a short-lived signed invitation, one-time acceptance, no unnecessary customer data,
audit logging and rate limiting. Refresh tokens must not be used as credentials for ordinary onboarding issuance.
