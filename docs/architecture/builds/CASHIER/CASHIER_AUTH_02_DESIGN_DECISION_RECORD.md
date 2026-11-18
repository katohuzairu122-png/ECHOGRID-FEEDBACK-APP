# CASHIER-AUTH-02: business-managed cashier identity, design decision record

Status: **DESIGN ONLY. No code, no migration.** Owner rulings D-1 to D-6 RECORDED 2026-11-18 (section 4A). CASHIER-AUTH-02A implementation is BLOCKED only on the migration prerequisite: PR #515 (migration 0081) is unmerged, so 0082 cannot be allocated.
Baseline: `origin/main` @ `81645bcbbebb5511ae6dad636ec6ca2e19627d77` (2026-11-18). Open PR at baseline: #515 (B2B S9-A1, claims migration 0081).
Nothing named CASHIER-AUTH-02 exists in the repository (grep for `CASHIER-AUTH`, `username`, managed cashier: no hits outside unrelated docs).

## 1. Reconciliation: what exists today
| Area | Fact (file) |
| --- | --- |
| Cashier identity | A cashier is an ordinary **staff `users` row** (`db/schema/users.ts`: `email text NOT NULL UNIQUE`, `password_hash NOT NULL`) holding the existing permission `loyalty:serve` via `user_business_roles` (business-wide or branch-scoped). No separate cashier principal. |
| Sign-in | `auth/cashier-auth.service.ts`: email + password (PBKDF2 via `Pbkdf2Worker`, dummy-hash constant cost), eligibility = `loyalty:serve` at business/branch, one-step or two-step (selection ticket, single-use, voided by password change). |
| Session | Own refresh-token family (`refresh_tokens.client='cashier'`, `business_id`, `branch_id`, `device_label`), signed `client/bid/brid` claims in the access token, rotation with replay containment (revokes only that session), per-refresh eligibility re-check (role/branch/business removal ends the session). |
| Route scope | `middleware/cashier-scope.ts`: deny-by-default allow-list of 8 routes, global guard, `CASHIER_CONTEXT_MISMATCH` on header mismatch. |
| Branch model | **Single and multi-branch already exist** through branch-scoped grants: several branch grants produce a selection step; a session is bound to one branch (`brid`). Branch is chosen at login only; there is no in-session switch. |
| Attribution | `loyalty_transactions.created_by` and `loyalty_purchase_events.created_by` are bare uuids (no FK); `loyalty_purchase_events.branch_id` exists. `business_customer_memberships` has no onboarding branch or cashier column. `audit_log.actor_user_id` FKs `users` (SET NULL). |
| Admin | Owner/Manager manage staff via the email invitation flow (`team-invitations`); `cashier-sessions` routes already list/revoke cashier sessions. Rate limits: `cashierAuthRateLimit`. |
| Counts | 26 schema FKs reference `users.id`; ~65 `.email` read sites in `apps/api/src`; `findByEmail` used by auth, cashier-auth, team routes, seed. |

## 2. The conflict
The directive forbids placeholder emails, yet `users.email` is `NOT NULL UNIQUE` and the entire authorization, session, audit and attribution stack keys on `users.id`.

### Option A (recommended): managed `users` row
Make `users.email` nullable; add `managed_business_id uuid` (FK businesses, RESTRICT), `login_username text`, `managed_by_user_id uuid`, `credential_changed_at`, `failed_login_count`, `locked_until`. CHECKs: a managed row has `managed_business_id` and username and NO email, no `platform_role`, and `email_verified_at IS NULL`; a normal row has an email and no managed columns. `UNIQUE (managed_business_id, lower(login_username))` partial index, plus the existing unique email index naturally ignores NULLs. Sign-in resolves the business first (business slug or dedicated cashier login code), then the username inside that business, so the same username in two businesses is two identities and never collides.
- Reuses roles, `loyalty:serve`, branch grants, tokens, rotation, audit FKs, attribution and the 8-route allow-list unchanged.
- Cost: a core-table change; nullable email widens types at the ~65 read sites (compile-checked); web `/auth/login`, password reset, invitations and email change must refuse managed rows (tested).
- Risk controls: DB CHECKs and triggers prevent a managed row from ever gaining an email, platform role or a non-cashier-eligible role set (see D-3); a managed row can only hold the `Cashier` role (D-2).

### Option B: separate `cashier_accounts` principal
Cleanest isolation, but `audit_log.actor_user_id`, `refresh_tokens.user_id`, `user_business_roles.user_id`, `findEffectiveKeys(userId)` and every attribution path assume `users.id`. Needs a parallel session, permission and audit path (new FK targets or dropped FKs). Larger blast radius; not recommended unless the owner wants hard physical separation.

## 3. Proposed 02A scope under Option A (after ruling)
1. Migration `0082` (0081 is claimed by #515; owner merges #515 first): the columns/CHECKs/indexes above, guard trigger, truncate denial per project pattern.
2. `managed-cashier.service`: create (owner/manager, derived business), reset credential, rename username, disable/enable/revoke, each in one transaction with an `audit_log` row and session revocation. Credential shown once, never logged.
3. Scoped login `POST /auth/cashier/login` extension: `{businessCode, username, password}`; generic failure for unknown business/user/wrong password; per-account lockout plus existing rate limiter.
4. Permission for administration: new catalog key (proposal `cashier:manage`, Owner and Admin by default; Manager only if D-4 says so). Not created until ruled.
5. Tests: the 15 adversarial cases in the directive that apply at 02A (1, 4, 5, 8, 9, 11, 13, 14, 15 plus username-namespace confusion and web-login refusal).
No UI, no branch-assignment changes, no onboarding attribution in 02A.

## 4. Decisions
Section 4A records the owner's rulings. The options table that was here is superseded.

## 4A. OWNER RULINGS (2026-11-18, authorization "CASHIER-AUTH-02A OWNER RULINGS AND DEVELOPMENT AUTHORIZATION")
| ID | Ruling |
| --- | --- |
| D-1 **Option A** | Managed identities live in the existing `users` table. Nullable email with strict database constraints distinguishing normal users from managed cashier identities. Preserve existing user ids, tenant-aware permissions, session references and audit relationships. |
| D-2 **Approved** | Managed cashier identities receive only a fixed Cashier role. No business dashboard, platform administration, billing, team management or account recovery. Ordinary staff identities and email-based cashier authentication keep working. |
| D-3 **Separate business code** | A unique, owner-rotatable cashier business code. Login = business code + cashier username + password. The business is resolved before the scoped username is validated. Codes are public identifiers, not secrets. Generic authentication failures prevent enumeration. |
| D-4 **Owner + authorized Admin** | Owner and authorized business Admin manage cashier accounts. A Manager may do so only through an explicit Owner-controlled authorization. New narrowly scoped `cashier:manage`, NOT automatically granted to all managers. Enforced server-side. |
| D-5 **Approved credential policy** | Minimum password length 8. Default initial password cryptographically random, 24 characters, provisioned by an administrator, shown once, never stored in plaintext. Five failed attempts in 15 minutes trigger a 15-minute lockout; existing IP and authentication rate limits retained; mitigate enumeration and deliberate-lockout abuse. Fresh administrative reauthentication within 5 minutes for sensitive changes. No cashier-controlled password change or email recovery. Reset revokes active cashier sessions; disable revokes sessions immediately. All administrative changes audited. MFA is a separate future block and is NOT implemented. |
| D-6 **Existing PBKDF2** | Preserve the existing PBKDF2 and constant-cost verification architecture and its currently supported iteration configuration. Do not weaken hashing, verification or rate limiting. Stronger KDF evaluation is separate future work. |

### Prerequisite status (2026-11-18)
- `origin/main` = `81645bcbbebb5511ae6dad636ec6ca2e19627d77`; journal ends at `0080_business_public_profiles`; no `0081` on main.
- PR #515 (B2B S9-A1, migration 0081): OPEN, draft, unmerged. PR #516 (this record): OPEN, draft, unmerged.
- Therefore migration 0082 is NOT allocated and no 02A schema or code is written. 02A starts only after #515 is integrated into main (owner merges) and the ledger is re-confirmed.

### Implementation notes carried into 02A (from the rulings)
- Reauthentication: a short-lived (5 minute) proof that the administrator re-entered their password, checked server-side on every sensitive mutation. Not MFA.
- Lockout counts failures per managed identity within a 15 minute window; an unknown business code or username spends the same IP-level budget and returns the same generic failure, and a locked identity is indistinguishable from a wrong password to the caller.
- Every site that reads `users.email` must be audited for NULL (about 65 read sites at baseline) and managed identities refused by web login, signup, invitation, password reset and email-change flows.
- Eight-route cashier allow-list unchanged. Existing eligibility rule (`loyalty:serve`) unchanged.

Also open for later blocks: onboarding attribution columns (02D) must not backfill history; branch switching (02C) needs an in-session rebind endpoint and a re-eligibility check per request; existing email login for cashiers stays during transition.

## 5. Dependencies and conflicts
- Migration number: 0082 after #515 merges.
- No overlap with Split 01 (#514), Community or loyalty economics; `loyalty:serve` and the allow-list are consumed, not changed.
- Existing cashier contracts to preserve: single-use selection ticket, replay containment, per-refresh re-check, route allow-list, audit of denials.

## Changelog
- 2026-11-18: created.
- 2026-11-18: owner rulings D-1 to D-6 recorded; 02A blocked on #515 (migration 0081).
