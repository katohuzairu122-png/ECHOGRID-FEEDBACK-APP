# BIZ-CLOSE-01: Business closure request (Pre-staging batch 02, item 2)

Status: IMPLEMENTED, validation pending hosted CI. Migration 0094 (additive, not applied to any shared database). Closure PROCESSING is deliberately NOT implemented.

## Scope and the policy boundary
Specification source: `docs/privacy/DELETION-REQUEST-DESIGN.md` section 7 (owner-only request, row + audit + ops alert, deletes nothing, does not change operation). The batch adds reauthentication, explicit confirmation, eligibility and obligation checks, state management and a controlled blocked state.

No financial settlement, forfeiture, refund or legal retention rule is invented. Those are unapproved policy, so **processing is permanently `blocked`** in this block: the evaluation always reports `CLOSURE_POLICY_NOT_APPROVED`, plus one blocker per kind of outstanding obligation. There is no approve, process or delete route, no `processed` status is admitted by the database, and no real business is closed.

## Behaviour
| Concern | Implementation |
|---|---|
| Who | `business:delete` (Owner by default; never Admin/Manager) + business-wide access + live tenant context. Cashier tokens are refused by the route allow-list. Impersonation sessions cannot re-authenticate. |
| Reauthentication | `POST /business-closure/reauth` (rate limited like cashier admin) issues a 5 min proof bound to user + business, of its own purpose type `business_closure_reauth` (a cashier-administration proof is refused). |
| Explicit confirmation | The business name must be typed exactly (`CONFIRMATION_MISMATCH` otherwise). |
| Idempotency / concurrency | Partial unique index (one `pending` per business) + `ON CONFLICT DO NOTHING`; 6 parallel requests produce 1 row, 1 audit row, one 201. Insert and audit commit in one transaction (no request without evidence). |
| Withdrawal | pending -> cancelled only (owner, reauth), audited, idempotent; a new request can be filed afterwards. |
| State integrity | DB guard: INSERT must be `pending`; only pending -> cancelled with all other columns unchanged; DELETE and TRUNCATE denied; `processed` reserved. |
| Eligibility | Read-only aggregate counts: pending redemptions, customers holding points and total, memberships, open reward claims, active subscriptions, signed-in cashier sessions, staff, published Community posts, followers. Counts only, no customer identity. Snapshot stored with the request as evidence. |
| Platform visibility | `GET /platform/business-closure` and `/:id` (platform admin only, read-only). Ops alert via `notifyOps` carries ids only. |
| Operation unchanged | Test proves business status, loyalty accounts, points, memberships and roles are identical before/after filing. Suspended businesses are refused (`BUSINESS_NOT_ACTIVE`). |
| Independent identities | Nothing touches `customers` or unrelated memberships. |

## Cross-module reconciliation (read-only reporting)
Loyalty accounts/points, customer memberships, rewards claims (orphan settlement), pending redemptions, subscriptions, staff (employee accounts), cashier sessions, Community publishing and followers are reported. Business discovery (public profile) and Tentaship Badges eligibility are unchanged by a request; badge awards earned from a closed business are a processing-policy question (see TB documents), not decided here.

## Files
Migration `apps/api/drizzle/0094_business_closure_requests.sql`; schema `db/schema/business-closure-requests.ts`; `apps/api/src/business-closure/*`; `apps/api/src/platform/business-closure.routes.ts`; runtime-role manifest entry (RUNTIME: INSERT, SELECT, UPDATE); web `dashboard/settings/closure`, `lib/actions/business-closure.ts`; four-language messages (`dashboard.closure`, `dashboard.settings.closure*`).

## OWNER DECISIONS / BLOCKERS (not invented)
1. Settlement of customer point balances and rewards owed; forfeiture and refund rules; subscription wind-down.
2. Legally required retention for transaction, audit and financial records; legal-hold policy.
3. Who in the platform team may authorise processing, and the processing design (a later, separately authorised block).
4. CUST-DEL-03 (customer erasure) remains on hold independently.
