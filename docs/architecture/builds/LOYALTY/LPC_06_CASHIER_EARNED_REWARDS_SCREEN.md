# LPC-06: cashier screen for earned programme rewards

Status: implemented, validation pending Owner merge. No migration, no deployment, no feature activation.

## What changed
- The scan response's customer card now lists the member's earned, unused, unexpired programme rewards (`card.earnedRewards`: id, name, expiry), branch-limited rewards hidden at other branches.
- The scan screen (`Serve customers`, also the cashier app) shows an **Earned rewards** section with a **Hand over** button per reward. The server action re-resolves the QR token, uses only the freshly resolved account (never a posted id) and calls `POST /loyalty/accounts/:id/entitlements/:entitlementId/redeem`.
- Finding fixed: the LPC-05 redeem route was not on the cashier route allow-list, so a real cashier session would have been refused. It is now listed deliberately (nine counter routes). The earned-rewards list rides on `resolve-customer`, so no GET route was added.
- Cashier activity: `loyalty.entitlement_redeemed` is cashier activity (redemption attempt and success), so it appears in the cashier activity history.
- Four languages (en/es/fr/ar). Cashiers still cannot create, edit, activate or switch programmes.

## Verification
API unit 289 files / 4,601; web unit 182 files / 1,513; tsc and eslint clean; new tests cover the action (permission, malformed id, fresh account), the screen (list, submit, empty), the allow-list (API and web conformance), and the activity category. Hosted CI pending.

## Open
Customer card per programme (customer-facing), purchase reversals revoking rewards, tiers and reward catalogue.
