# OWNER-INVITE-01: owner-issued customer invitations (Pre-staging batch 03, workstream B)

Status: IMPLEMENTED, validation pending hosted CI. Migration 0096 (additive, not applied to any shared database).

## Reconciliation with PR #590
#590 removed the cashier-issued invitation route, page and action. It did NOT remove customer acceptance (`/customer-memberships/join-assisted[/preview]`), `customer_onboarding_events` (with the reserved `remote_invitation` source and its CHECK) or the cashier-assisted verifier. This block therefore does not revert #590: it adds a separate owner-side issuer and reuses the customer acceptance contract, so there is ONE customer-facing invitation flow, not a competing one. Historical cashier-assisted records are untouched.

## Design
| Concern | Implementation |
|---|---|
| Where | Inside the owner-facing Cashier App: `/dashboard/cashier/invitations`, linked from `/dashboard/cashier`. Not a top-level navigation entry. |
| Who | EXISTING permission `cashier:manage` with business-wide access (Owner and Admin by default; a Manager only if the Owner granted it). No new permission, no role change, no seed step. Cashier tokens are refused by the route allow-list (CASHIER_ROUTE_DENIED); the API routes `/customer-invitations*` are on no cashier path. |
| Record | `customer_invitations` (business, branch, issuer, optional request key, expiry, one-time revocation). DB guard: INSERT only, then the single revocation update; no DELETE/TRUNCATE. Runtime-role manifest entry. |
| Token | Signed link carrying ONLY ids (invitation, business, branch, issuer). It is a pointer: the database row decides. Type `customer_invitation`, never an access token. |
| Lifetime | 1 to 168 hours, default 24 (default is a proposal pending D01). |
| Single use | `customer_onboarding_events_remote_invite_once_key` (unique per business and invitation for source `remote_invitation`). Same customer retrying is idempotent; a second customer gets ONBOARDING_INVITE_USED. |
| Revocation | Owner revokes an unused invitation (idempotent, audited). An accepted invitation cannot be revoked. Revocation vs acceptance race: the join takes `FOR SHARE` on the invitation row first; tested to end in exactly one consistent outcome. |
| Validity at use | Row exists, not revoked, not expired, business active, branch active, issuer still active AND still holds `cashier:manage`. Every failure is the same generic customer error. |
| Idempotency, rate limit, audit | Optional request key; own rate-limit bucket `owner-invite:<business>:<user>`; `customer_invitation.issued/revoked` audit rows in the same transaction. |
| Customer | Unchanged web page `/loyalty/invite/<token>`; the customer signs in as themselves and gives explicit join consent. One platform identity; no duplicate account. |
| Distinct events | issued (row), opened (preview, read-only), accepted (consented join + onboarding event), identity verified (separate customer verification state), loyalty enrolled (membership), verified referral (NOT produced here). They are not equivalent. |
| Grants nothing | Tested: no Community membership, no badge award, no loyalty transaction or points, no new customer identity. |
| Privacy | Listing shows status, branch and times only: no customer identity; an accepted invitation shows only that it was accepted. |
| Closure | A suspended business cannot onboard anyone through an invitation (existing join gate; tested). Business closure processing remains blocked. |

## Verification (local)
10 PostgreSQL 16 integration tests (authorization incl. cashier token and Manager, tenant isolation, idempotency, rate-limit bucket, tampered/expired/revoked/foreign tokens, single use and replay, identity preservation, race, DB guard); web unit tests; Chromium desktop, 375 px mobile and Arabic RTL.

## Owner decisions (not invented)
D01: confirm the permission model (`cashier:manage`) and the default and maximum lifetime; whether managers may issue; whether invitations should ever be business-wide (no branch).
