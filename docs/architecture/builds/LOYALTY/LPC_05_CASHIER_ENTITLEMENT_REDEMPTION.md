# LPC-05: cashier hands over earned programme rewards

Status: implemented, validation pending Owner merge. No migration, no deployment, no feature activation.

## Purpose
LP-01 stamp cards and LP-04..LP-07 programmes grant single-use entitlements (`loyalty_program_entitlements`). A cashier needs to see and hand over an earned reward for the customer in front of them, without being able to change any programme.

## API (existing `/loyalty` router, permission `loyalty:serve`, tenant and branch context from the authenticated session)
| Route | Behaviour |
|---|---|
| `GET /loyalty/accounts/:id/entitlements` | Earned, unused, unexpired rewards for one account of this business. A reward limited to another branch is hidden. Reached by an account id the cashier already holds from a scan or lookup; not an enumeration (reviewed-GET list updated). |
| `POST /loyalty/accounts/:id/entitlements/:entitlementId/redeem` | Single-use atomic redemption. Audited as `loyalty.entitlement_redeemed`. |

## Rules enforced (service: `loyalty/programs/entitlement.service.ts`)
- Account must belong to the caller's business; otherwise uniform `LOYALTY_ACCOUNT_NOT_FOUND`.
- Suspended account: `LOYALTY_ACCOUNT_SUSPENDED` (409).
- Entitlement must belong to that account and business; used, expired or foreign rewards: `ENTITLEMENT_NOT_AVAILABLE` (409).
- Branch-limited reward at another branch: `ENTITLEMENT_NOT_AVAILABLE`.
- Double redemption race: one conditional UPDATE (`consumeEntitlement`, now optionally account-scoped); the database also forbids reopening or deleting a used entitlement.
- Cashiers cannot create, edit, validate, activate or switch programmes (Owner-only routes unchanged).

## Verification
API unit 289 files / 4,601 tests pass; full PostgreSQL integration on a fresh database 170 files / 1,968 tests pass (new LPC-05 case); RBAC matrix rows added for both routes (`serve` only).

## Not in scope (open)
Web cashier screen for entitlements, customer-card display per programme, purchase reversal that revokes entitlements, tiers and reward catalogue (Group 05).
