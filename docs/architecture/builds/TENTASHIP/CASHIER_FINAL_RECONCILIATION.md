# CASHIER-FINAL-RECONCILIATION (Pre-staging batch 02, item 1)

Status: IMPLEMENTED, validation pending hosted CI. No migration. No deployment.

## Ruling applied
Cashier App and Serve Customers are one functional module. The cashier interface (dedicated cashier PWA, cashier credentials, cashier token) exposes only Serve Customers, Redeem and essential utilities (account/sign out, session security, authorised branch switching, offline and error handling).

## Reconciliation of PR #589 (verified, not reimplemented)
| Requirement | Finding | Evidence |
|---|---|---|
| Owner-facing Serve Customers / Cashier App unified | Already satisfied: dashboard nav links Serve customers to `/dashboard/cashier`; management pages (accounts, sessions, activity) are reached from there | `dashboard-nav.tsx`, `dashboard/cashier/page.tsx` |
| Manage Cashiers, credentials | Existing `/dashboard/cashier/accounts` (`cashier:manage`, reauth proof) | unchanged |
| Active cashier sessions | Existing sessions panel (`business:manage_settings`) | unchanged |
| Transaction history / corrections / approvals | Existing `/dashboard/cashier/activity` and existing loyalty pages; reused, nothing invented | unchanged |
| Managers keep current permissions | No permission or role change | unchanged |

## Corrections made (smallest necessary)
1. Cashier nav no longer offers Invite; `/cashier/invite` route, `InvitePanel` and `cashierIssueInviteAction` removed.
2. `POST /loyalty/actions/onboarding-invite` removed from the cashier route allow-list (now 8 routes) and its handler removed: a cashier token gets `CASHIER_ROUTE_DENIED`; the route no longer exists for any other token. Customer acceptance (`/customer-memberships/join-assisted`) is unchanged.
3. Tests: allow-list exactness (8 routes), a forbidden-surface matrix (customer lists, accounts, adjustments, reports, settlement, rewards, Community, cashier administration, business administration, closure), a route-tree guard for the cashier web app, host-isolation test updated, invitation acceptance integration tests re-based on a direct signer, branch-delete revocation probe moved to an allowed route.

## Preserved boundaries
Separate cashier credentials, dedicated cashier token context, `CASHIER_HOST` isolation, branch-scoped access, live-session check on every request, revocation, secure sign-out: untouched.

## OWNER DECISION REQUIRED
Customer invitation is withdrawn from the cashier interface. The ruling places "Invite Customers (where approved)" in the owner-facing Cashier App, but approval and the issuing model (an invitation is currently bound to a cashier session and branch) are not defined. Not invented here. Until decided there is no invitation issuer. The opt-in acceptance harness (`apps/api/scripts/acceptance/cashier-02`, Playwright `cashier-02.spec.ts`) has invitation-dependent scenarios marked superseded; live execution remains disabled.
