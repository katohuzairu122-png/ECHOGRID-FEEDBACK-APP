# ECHO GRID — SPLIT 07 BLOCK 1: CONTRACTS, SCHEMA & APPEND-ONLY FOUNDATIONS

**Status:** IMPLEMENTATION CONTRACT — DO NOT EXECUTE IN THIS PR  
**Architecture:** `ECHO_GRID_SPLIT_07_PARTNER_LAYER_CREDITS_v1.0.md`  
**Block:** 1 of Split 07  
**Baseline:** `main` after finalization PR merge

## Objective
Create strictly additive, inert Partner Credit domain foundations. No award decisions may produce live credit yet. No migration or runtime code is included in this architecture finalization.

## Deliverables for a later implementation PR
1. Zod/TypeScript contracts for PartnerCreditPolicy v1, enrollment, award decisions, account DTO, immutable ledger entry, credit lot/vesting, reversal recovery, and account-history read DTO. A nullable future billing reference must not be interpreted as a charge.
2. Drizzle schema and next available additive migration for partner program enrollments, immutable versioned policies, partner credit accounts, award decisions, append-only ledger, credit lots/allocations, and recovery obligations as justified by invariants. Future billing reservations are contract-only until Split 08.
3. Repositories with **read/insert foundation methods only**, scoped by business, explicit transactions and constraints. No issuance, vesting, redemption, adjustment, recovery processing, or Stripe integration service.
4. New permission catalog entry `partner_credits:view` proposed for business-wide authorized account inspection, with role mapping intentionally reviewed against the current actual seeds. Do not automatically grant branch managers access to business-wide financial data. Platform admin routes/permissions require separate review; no mutation endpoints in Block 1.
5. CI tests for schema, uniqueness, append-only immutability and forbidden writes. Real PostgreSQL migration replay and rollback-on-conflict required.

## Source of truth & constraint details
- One `partner_credit_accounts` per `business_id` with a unique index. `branches` do not get accounts.
- One earning decision per eligible `settlement_ref` (unique) and one reversal recovery per authoritative reversal reference (unique).
- Stable UTC earning-month snapshot must support the 10-credit cap across branches; atomic enforcement is deferred to earning service Block 2, not implied by a uniqueness index alone.
- Ledger entries are append-only; database-level protections should prevent update/delete of economic events, including privileged application paths; projected balances must reconcile to history.
- Quantity is an integer non-cash unit. Monetary/currency value is deliberately absent from Partner Credit ledger and evidence.
- Policy versions immutable once effective; existing decisions retain policy snapshots. Use effective windows and a single active rule per scoped period.
- Record completion source references only; validate live Split 06 state before later awards. No event consumer or automatic backfill in Block 1.
- Provisional lots must support 14 days hold; explicit expiry 12 calendar months after vest; partial consumption/recovery allocations auditable; no negative available credits.
- Future Split 08 may decide only the invoice application of credits; **do not add Stripe ID or business subscription mutation to Block 1**.

## Isolation & permissions
| Domain | Block 1 rule |
|---|---|
| Origin/receiving loyalty | No writes and no point conversion |
| Community Points | No reads for eligibility, no writes |
| Orphan Settlement | Read-only evidence contract reference; no settlement state changes |
| Partner Credits | Schema, types, repo foundation only; no minting |
| Subscription / Stripe | No writes, no discount or invoice API |
| QR | Remains context-only, no credit information |

## Mandatory implementation tests
- Duplicate account business ID rejected.
- Duplicate settlement award decision rejected even across requests/branches.
- Duplicate reversal reference rejected.
- FK/tenant scopes and snapshots valid.
- Event append-only guarantees enforced.
- No negative available projection.
- Migrations fresh-Postgres pass, existing migration drift unaffected.
- Permission denial for unrelated business, branch-scoped user, ordinary staff, impersonation, and all customer actors.
- No Partner Credit or billing write paths exposed during foundation stage.
- Static, unit, integration, API/web types/build and browser gates as repo standard.

## Explicit non-goals
No Partner Credit issuance or vesting; no consumption; no automated sweep; no queue consumer; no compensation amounts; no conversion of business or Community points; no customer-visible value; no billing/Stripe mutation; no automatic historical award backfill.

## Gate after Block 1
Only after fresh CI and merge may Block 2 begin: **Verified settlement evidence evaluation, enrollment eligibility and provisional award decision service** under the frozen policy. Block 2 must still not enable Split 08 invoice application.
