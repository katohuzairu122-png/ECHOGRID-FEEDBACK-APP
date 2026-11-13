# Platform console guide

**Status: DOCUMENTATION ONLY. Written 2026-11-13 from the code on `main` `532e65c4` and a read-only count on the production database. It describes what exists today, and says plainly what does not.**

The platform console is where Echo Grid's own staff look across all businesses and manage the platform. It is separate from the business dashboard that a business owner uses.

## 1. How a platform user gets in

1. A platform user is an **ordinary user account with a platform role** set on it. There is no separate admin login page and no separate admin application.
2. They sign in at the normal `/login` page with their email and password.
3. Their business dashboard home then shows a **Platform** panel with an "Open platform" link. They can also go straight to `/platform`.
4. A signed-in user **without** a platform role who opens `/platform` sees an "access denied" page. Signed-out visitors are sent to `/login`.
5. The same account can also hold ordinary business roles. Business roles and platform roles are independent: platform roles do not change what a person can do inside a business, and business roles do not grant anything in the console.

State on 2026-11-13: production has **one** platform user, an active `admin`.

## 2. Platform roles

There are three roles. They are not a hierarchy: each route lists exactly which roles it admits.

| Role        | Can do                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **support** | Read the business directory, the audit log and billing. Impersonate a business's staff member to debug.                                 |
| **billing** | The same read-only views, plus create and edit subscription plans. **Cannot** impersonate.                                              |
| **admin**   | Everything above, plus suspending or restoring a business, sending an ops test alert, and the admin-only operations noted in section 4. |

## 3. What the console contains

| Page                        | What it is for                                                                                        | Roles                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `/platform`                 | Overview.                                                                                             | any platform role                                     |
| `/platform/businesses`      | Directory of all businesses, with search and filters.                                                 | support, billing, admin                               |
| `/platform/businesses/[id]` | One business: details, status change (suspend or restore, with a recorded reason), and impersonation. | view: all; status: admin; impersonate: support, admin |
| `/platform/audit-log`       | Cross-business audit log, filterable by business, actor, entity type, action and date.                | support, billing, admin                               |
| `/platform/billing`         | Subscriptions across businesses.                                                                      | support, billing, admin                               |
| `/platform/billing/plans`   | Subscription plans (create and edit).                                                                 | view: all; edit: billing, admin                       |

### Impersonation

An authorized user can see the product exactly as one specific staff member of a business would. The system mints a short-lived token and checks that the target user is active and actually holds a role at that business. Impersonation is audited. While it is active, a banner is shown on the dashboard, and it can be stopped from there. Impersonation tokens are refused by admin-only billing-read sessions.

## 4. Other platform functions that exist without a console page

The API has platform routes with no page in the console today. Use them only through an authorized tool, and read the route files for the exact roles:

- ops test alert (admin only): checks that operational alerts reach the ops channel;
- community point rules, ledger and adjustments;
- orphan settlement operations. Some reversal and qualification actions require the `admin` platform role.

## 5. Creating or restoring a platform admin

- There is **no invite flow** for platform roles and **no screen or API to grant or revoke a platform role**. The first admin is created by the setup script `db:seed:platform-admin` (`apps/api/src/db/seed/platform-admin.seed.ts`). It reads `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` (at least 12 characters) and `PLATFORM_ADMIN_NAME` from the environment and connects with `DATABASE_URL`.
- The script is idempotent: if the email already exists it only confirms or restores the `admin` role on it.
- **Never paste a password or database URL into a chat, a ticket or a pull request.** Set them only in your own shell for the run, then clear them.
- Granting `support` or `billing` to someone has no tool today; it is a direct database change and needs its own authorization and an audit note.

## 6. Recommended setup: a dedicated platform admin account

A separate account used only for platform work is the better practice, and the code supports it because the platform role is just a property of a user:

1. **Separate email and a unique strong password**, not the owner's everyday business login. Keep it out of any business so it never appears in a business's team list.
2. **Do not use it for daily business work.** Sign in to it only for platform tasks.
3. **Keep a second admin as a recovery path** (a break-glass account whose password is stored offline). With one admin, losing that login would require database access to recover.
4. **Use `support` or `billing` roles for anyone who only needs read or billing access** instead of giving them `admin`.
5. **Review the audit log regularly** for platform actions such as status changes and impersonation.

## 7. Known gaps

- **No two-factor sign-in** exists for staff or platform accounts today. Customers have OTP login; platform users have email and password only. This is the largest gap for an account that can act across all businesses.
- **No console page** to manage platform users or roles.
- Suspending a business, impersonation and billing actions rely on the admin's password and the audit log as the main controls.

Candidate hardening, each its own authorized block: Cloudflare Access (or an IP allow-list) in front of `/platform`; two-factor sign-in for platform roles; a role-management page with audit; a separate hostname for the console.
