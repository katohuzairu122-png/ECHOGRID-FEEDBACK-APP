# CASHIER-AUTH-02B: branch assignment and the Cashier Accounts management UI

Status: IMPLEMENTED, development only. Not merged, not deployed. NO migration (the 02A schema already carries everything 02B needs), so nothing here touches any shared database.
Scope: 02B only. Not included: 02C in-session branch switching, 02D onboarding attribution, 02E full acceptance, mandatory MFA.
Owner direction (2026-11-18): proceed; cashier accounts are created separately as an administrative task by the Owner or an authorised Admin. No cashier, and no automation, creates accounts. (This also confirms that Admin holds `cashier:manage` by default.)

## Branch model
- Single branch = exactly one explicit branch. Multiple branches = two to 50 explicit branches of the same business. The mode is DERIVED from the active grants (one grant = single), never stored, so it cannot drift from the real authority.
- Authority is the existing branch-scoped `user_business_roles` grant of the business's `Cashier` system role. The 02A database trigger already forbids a business-wide grant, another role, another business or another business's branch for a managed identity.
- A new branch of the business is never granted automatically; only an explicit assignment adds one.
- Multi-branch is not business-wide administration: a managed identity can never hold a business-wide grant or any administrative permission (the role is fixed at business:view, branches:view, loyalty:serve).

## Behaviour
- `POST /cashier-accounts` accepts `{accessMode, branchIds}` (the 02A `{branchId}` shape still works).
- `PUT /cashier-accounts/:id/branches` replaces the assignment atomically. The account row is locked first, so concurrent changes serialise. Removed grants are soft-deleted (history kept); only the sessions bound to a REMOVED branch end, in the same transaction, so they stop working on the very next request and cannot refresh. Sessions on kept branches are untouched. Unchanged input is accepted and writes no audit row. Every change is audited with added, removed and sessionsRevoked.
- Sign-in is unchanged and already correct for both modes: one branch signs in directly; several branches return a single-use selection ticket listing ONLY the assigned branches, and the server refuses a branch that is unassigned, another business's, or missing. Every later request is bound to the branch in the signed token; a different `X-Branch-Id` or `X-Business-Id` is refused (`CASHIER_CONTEXT_MISMATCH`). Client-supplied branch ids are never proof.
- Same authorization as 02A: `cashier:manage`, business-wide access and the 5-minute password re-entry proof. A Manager is denied unless the Owner granted `cashier:manage`; a cashier token reaches none of it.

## UI
- Dashboard `/dashboard/cashier/accounts` (visible only with `cashier:manage`): password confirmation card; business code with rotate; create form with single/multiple access and branch tick boxes; account list with status, branches, mode, lock state and last sign-in; edit branches, reset password, disable/enable, sign out devices, revoke. Destructive actions ask for confirmation. A generated or reset password is shown once and then discarded from the page; an administrator-chosen password is never shown back. The 5-minute proof lives in an httpOnly strict cookie scoped to `/dashboard/cashier`, read only by server actions.
- Cashier PWA sign-in gains a business code mode (business code, username, password) beside the existing email form, which is unchanged; a multi-branch cashier then picks among the returned branches. The existing active business and branch display is unchanged.
- Existing design components and next-intl are used; all new text exists in en, fr, es and ar.
- Not included: a per-account session list inside the account row (the existing business Sessions panel already lists and revokes cashier sessions), and a per-cashier activity view (the existing Cashier activity page covers cashier activity).

## Decision interpretations (owner to confirm)
1. Branch removal ends only the sessions on the removed branch, not all of the cashier's sessions.
2. Switching a multi-branch cashier between branches inside a session is NOT built (02C); today the cashier signs in again to choose a different branch.
3. The maximum assignment is 50 branches.

## Changelog
- 2026-11-18: created with 02B.
