# ECHO GRID — SPLIT 01
## Identity & Customer Relationship — Implementation Specification v1.0

**Status:** FROZEN FOR EXECUTION  
**Baseline:** main @ ddb72fdc5c30780e9dd22c852a657a55deae88e1  
**Authority:** Echo Grid Master Architecture v1.0  
**Split:** 01 of 10

## Frozen objective

```text
GLOBAL CUSTOMER IDENTITY
        ↓
BUSINESS CUSTOMER MEMBERSHIP
        ↓
LOYALTY ACCOUNT
        ↓
LOYALTY TRANSACTIONS
```

### KEEP
- global `customers` identity and unique phone
- staff `users`
- customer OTP authentication
- staff authentication
- roles / permissions / `user_business_roles`
- tenant and branch scoping
- all existing loyalty balances and transaction history

### ADD
- `business_customer_memberships`
- `consent_grants`
- `customer_action_authorizations`
- membership / consent / customer-authorization repositories and services
- explicit relationship/consent contracts and tests

### ADAPT
- `loyalty_accounts` gains a membership link
- customer join flow requires an authorized business context
- QR check-in cannot silently create membership
- customer membership queries use the relationship domain as authority

## Hard invariants
1. One global customer identity may participate in many businesses.
2. One authoritative membership per `(customer_id,business_id)`.
3. `business_customer_memberships` owns the relationship; Loyalty owns points/rewards.
4. Joining requires authorized business context plus explicit `JOIN_LOYALTY` consent.
5. QR/check-in never silently creates a relationship.
6. Existing loyalty balances and ledger history are preserved exactly.
7. Customer and staff identity systems remain isolated.
8. Cross-tenant staff access remains forbidden.
9. Sensitive customer actions use short-lived consumable authorization, not only a long-lived customer JWT.
10. Duplicate joins/action consumption are idempotent.

## Membership states
`pending | active | suspended | left | business_exited | closed`

## Initial consent purposes
`join_loyalty | marketing | survey_participation | settlement_access | contact_sharing`

## Initial customer action types
`redeem_reward | access_orphan_settlement | complete_settlement | share_contact_details`

## Migration order
1. Create relationship/consent/action-authorization tables.
2. Add nullable `loyalty_accounts.membership_id`.
3. Backfill one membership per existing loyalty account.
4. Link existing loyalty accounts to memberships.
5. Validate uniqueness/alignment/economic preservation.
6. Strengthen constraints only after validation.
7. Cut join/check-in behavior to the relationship authority.

## Prohibited shortcuts
- unrestricted businessId-only joining
- check-in auto-enrollment
- consent stored only in UI/local state
- one blanket consent flag
- customer/staff auth merge
- economic history rewrite
- cross-business relationship leakage
- architecture changes for implementation convenience

## Definition of Done
Split 01 is not LOCKED COMPLETE until migrations, backfill, join/QR changes, consent/action authorization, tenant isolation, idempotency, reconciliation, typecheck, lint, tests, integration tests and build all pass.

## Conflict rule
If implementation conflicts with the frozen Master Architecture or this split: **STOP AND REPORT. Do not invent a workaround or redesign the architecture.**
