# CASHIER-AUTH-02C: secure in-session branch switching

Status: IMPLEMENTED, development only. Not merged, not deployed, no migration. Scope: 02C only (not 02D onboarding attribution, not MFA, not a rate-limit change).
Baseline: main `cf4d1523640af27d3d6d7b3bb6753c6be54bc387` (02A and 02B merged), journal ends at 0082.

## Decision: reuse, no schema change
A branch is part of the session binding (`refresh_tokens.branch_id` plus the signed `brid` and `sid` claims). A cashier access token is valid only while its session has an unrevoked row. So a switch REPLACES the session: a new session id and new tokens bound to the target branch, and the old session's rows revoked, in one transaction. Every pre-switch access token then fails its next request through the existing liveness check (`isSessionLive`), with no new column and no change to token claims. Switching back to an earlier branch is again a NEW session, so an old token for that branch cannot come back to life. (A migration would also have conflicted with the number proposed for 02D; none is needed.)

## Operation
`POST /api/v1/auth/cashier/switch-branch` `{ refreshToken, branchId, fromBranchId? }`. Like refresh and logout it takes the session's own refresh token in the body and never a bearer, so it is outside the eight-route cashier allow-list (a cashier access token gets `CASHIER_ROUTE_DENIED`). The allow-list is unchanged. `POST /auth/cashier/branches` `{ refreshToken }` returns the current branch and the currently assignable branches (read-only, advisory).
Server-side, in one transaction (`CashierAuthService.switchBranch`):
1. verify the refresh token, identify the session (the verified identity is attached before any decision so even a refusal is an attributed security event);
2. take an EXCLUSIVE lock on the session rows (serialises with refresh, other switches and in-flight mutations);
3. re-read under the lock; require: account active, managed identity of this business, not locked, business active, the current binding still authorised, and the target is a currently assigned, live branch of the same business that carries `loyalty:serve`. The client's branch id is only a request;
4. replace the session (new id, new access and refresh tokens, presented token marked superseded and linked to its successor, old rows revoked);
5. write the audit row `auth.cashier_branch_switched` (identity, business, previous and new branch, previous and new session id, time, device/IP/user agent; no token or password) in the same transaction.
Any failure, including the audit write, rolls the whole switch back (tested by injecting an audit failure).

## Owner rulings
- D-1: no password for an active, valid session; expired, revoked, locked or disabled sessions cannot switch.
- D-2: the checks above, all independent of the client.
- D-3: session replaced; old branch authorization stops at once; refresh replay containment preserved AND extended: replaying a pre-switch refresh token now ends the descendant session as well (the replacement chain is followed).
- D-4: success audited as above; denials use the existing security-event recorder (`security.authorization_failed`, attributed to the cashier and business, no token material). The new action is in the cashier "session" history category.
- D-5: see below.
- D-6: a refused switch changes nothing (tested).
- D-7: single-branch accounts cannot switch (another branch: `CASHIER_ACCESS_DENIED`). Requesting the branch already active is a documented no-op: HTTP 200, `switched:false`, nothing rotated, revoked or audited.

## In-flight transactions (D-5) and ordering
Purchase and redemption confirmation take a SHARED lock on the live, still-bound cashier session row at the start of their own transaction (`assertCashierSessionBound`); a switch takes the EXCLUSIVE lock first. Exactly one order happens: the mutation commits first and keeps the branch it was authorised for, then the switch proceeds; or the switch commits first and the mutation (even one whose token had already passed authentication) finds no live row for its old branch and is refused with `CASHIER_SESSION_CHANGED` before writing anything. A mutation is never re-attributed to the new branch and a stale token never writes after a switch. Duplicate protection is the existing idempotency key and conditional confirm; a retry after a switch is a new authorization (tested for no duplicate and correct branch).
Multiple windows: cookies are shared, so a window drawn for the old branch sends the old branch id, which the API already refuses against the signed binding; the PWA also checks the drawn branch against the session context first and reloads the counter instead of showing an error. `fromBranchId` turns a stale or concurrent switch into `CASHIER_SWITCH_CONFLICT` (409). Two simultaneous switches with one credential: exactly one wins, the other gets 409 (or 401), one live session remains.

## Scope decisions (owner to confirm)
1. Only MANAGED cashier identities may switch. Staff-email cashier sessions get `CASHIER_SWITCH_NOT_AVAILABLE` and keep signing in again. (Switching for ordinary staff would need its own ruling about business-wide and branch-less sessions.)
2. A locked identity cannot switch (fail closed), although its existing sessions keep serving.
3. `canSwitchBranch` in the cashier context cookie is a display flag refreshed at sign-in, selection and every token refresh (at most 15 minutes stale). The server is the authority on every switch.

## PWA
Header switcher (`BranchSwitcher`): shown only when the context says the account has two or more branches; single-branch accounts see their branch and no switch action. The dialog fetches the current list each time it opens, marks the current branch, requires an explicit different choice, shows success after the server confirms, refreshes the list on conflict or denial, and offers retry on failure. An ended session signs out. The serve and redeem screens are keyed by branch so a switch discards lookup results and pending confirmations. en, fr, es, ar (RTL covered by test).

## Not changed, tracked separately
Rate-limit policy (new routes use the existing floor, no new strict bucket), MFA, onboarding attribution (02D), production `cashier:manage` backfill, staging rollout of 0082 (done earlier), the 0080/0081 co-application note.

## Changelog
- 2026-11-18: created with 02C.
