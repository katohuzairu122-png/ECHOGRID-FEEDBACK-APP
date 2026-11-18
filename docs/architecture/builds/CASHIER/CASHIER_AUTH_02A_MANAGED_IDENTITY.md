# CASHIER-AUTH-02A: managed cashier identity foundation

Status: IMPLEMENTED, development only. Not merged, not deployed. Migration 0082 is NOT applied to staging or production.
Implements owner rulings D-1 to D-6 (`CASHIER_AUTH_02_DESIGN_DECISION_RECORD.md` section 4A, merged #516). Scope: 02A only. Not included: 02B branch-assignment UI, 02C in-session branch switching, 02D onboarding attribution, 02E full acceptance, any UI, mandatory MFA.

## What it adds
- Migration `0082_cashier_managed_identity`: `users.email` nullable; `users.managed_business_id`, `login_username`, `managed_by_user_id`, `credential_changed_at`, `failed_login_count`, `failed_login_window_started_at`, `locked_until`; `businesses.cashier_code`, `cashier_code_rotated_at`.
- Constraints: `users_managed_shape_check` (a managed row has business, username, provisioner and NO email, platform role or verified email; a normal row has an email and none of the managed columns), `users_login_username_check`, `users_managed_username_key` (unique per business), `businesses_cashier_code_unique` and `_check`.
- Triggers (ENABLE ALWAYS): `users_managed_identity_guard` (binding and provisioner immutable in both directions) and `user_business_roles_managed_guard` (a managed identity holds only branch-scoped grants of its own business's system role `Cashier`).
- `ManagedCashierService`: create, reset credential, rename, disable, enable, revoke, revoke sessions, rotate business code; each in one transaction with its audit row.
- `CashierAuthService.managedLogin` and `POST /auth/cashier/managed-login` (business code + username + password). Everything after the credential check (eligibility, session, refresh rotation, replay containment, allow-list) is the existing code.
- `/cashier-accounts` admin routes (permission `cashier:manage`, business-wide access, 5-minute password re-entry proof on every mutation).
- Permission `cashier:manage`: catalog, Owner and Admin defaults, backfill. NOT granted to Manager or Staff.

## Behaviour notes
- Every managed sign-in failure is one generic 401 after exactly one PBKDF2 verification. Lockout: 5 failures in a rolling 15 minutes lock for 15 minutes; failures while locked are not recorded (a lock cannot be extended); a correct password never unlocks.
- Credentials: administrator-supplied (8 to 128 chars) or generated (24 chars, about 139 bits). Returned once with `Cache-Control: no-store`; stored only as PBKDF2 hashes; never written to audit metadata.
- Status maps onto `users.status`: active, suspended (= disabled, reversible), deactivated (= revoked, terminal).
- The re-authentication proof is password re-entry, NOT MFA.

## Audit of `users.email` assumptions (non-null no longer guaranteed)
Fixed or guarded: password reset request, password reset confirm and password change (managed identities refused), post-password-change notice (skipped when no email), billing checkout contact (refused), notification address (undefined), impersonation (managed identities refused; target email nullable in the result), team invitation acceptance (null never matches), platform team listing and cashier session listing (email nullable; the session listing also returns `username`). Email lookup paths (`findByEmail`) can never match a managed row. Test fixtures that build full `User` rows were updated.

## Compatibility
- Additive and backward compatible: existing rows satisfy every new constraint (verified by applying 0082 to a database holding 152 existing users). No existing user, role, grant, audit or session row is changed.
- Existing email sign-in (web and cashier) is unchanged and covered by regression tests. The eight-route cashier allow-list is unchanged.

## Rollback
Before any managed account exists (the state of every shared environment until separately authorized): drop the two triggers and their functions, drop the new constraints and index, drop the new columns, then `ALTER TABLE users ALTER COLUMN email SET NOT NULL` (valid only while no row has a null email). After managed accounts exist, roll forward: revoke the accounts (`status = deactivated`), then retire them by an owner-approved data migration, because `email SET NOT NULL` cannot succeed while managed rows exist. Application rollback is independent: the managed routes can be unmounted without touching data.

## Decision interpretations (owner to confirm)
1. "Authorized business Admin": the default Admin role holds `cashier:manage`, like Owner. A business can remove it from Admin.
2. Single branch only at creation in 02A (one explicit branch); further assignments are 02B.
3. The `Cashier` role is a per-business system role created on first use, with exactly business:view, branches:view and loyalty:serve (identical to the default Staff counter role). Creation fails closed if a custom role named Cashier exists or the system role was altered.
4. A business code is created on first managed-cashier creation; rotation does not end live sessions.

## Changelog
- 2026-11-18: created with 02A.
