# LPC-10: Owner purchase-reversal interface

Status: implemented, validation pending Owner merge. No migration, no deployment, no feature activation. Stacked on LPC-08 (purchase reversal API).

## Screens (Loyalty > Purchases, owners and managers holding `loyalty:adjust`)
- **Purchases** (`/dashboard/loyalty/purchases`): purchases newest first, filter All / Confirmed / Reversed (the **reversal history**), paging. Amounts are the exact decimal text the ledger stores, shown with the business currency.
- **One purchase** (`/dashboard/loyalty/purchases/:id`): the original purchase (customer, date, amount, channel, points earned), the **exact impact** of reversing it (points taken back, **shortfall**, earned rewards withdrawn, **previously used reward warning**), a **mandatory reason** (3 to 200 characters) and an **explicit confirmation**, then the **result** (points reversed, shortfall, rewards revoked, needs-review flag).
- A reversed purchase shows its recorded outcome and no form: **duplicate reversal is prevented** in the screen and refused by the API (409 `PURCHASE_ALREADY_REVERSED`).

## API additions (all `loyalty:adjust`, business-wide, read-only except the existing reversal)
- `GET /loyalty/purchases` (status, accountId, limit up to 50, offset), `GET /loyalty/purchases/:id`.
- `GET /loyalty/purchases/:id/reversal-preview`: runs the real reversal inside a transaction that is **always rolled back**, so the preview cannot differ from the result and writes nothing (tested: points, ledger, status, entitlements and progress history unchanged).
- The reversal response now lists `rewardImpact` (reward name, revoked or already used).

## Authorization
Enforced at the API boundary: `requirePermission('loyalty:adjust')` plus business-wide access on every route; a cashier token is refused by the cashier route allow-list before any handler runs (tested for all four paths, and in the RBAC matrix). The sub-navigation entry and the page gate (`canReversePurchase`, `reversalGate`) are presentation only. The three new GET routes were added to the reviewed GET-route list deliberately (customer names appear exactly as in the existing account directory; paged; scoped to the caller's business).

## History is append-only
Nothing is deleted or edited: a reversal marks the purchase `reversed`, appends a negative ledger adjustment, appends a `reversed` progress event and sets unused earned rewards to `reversed`.

## Verification
API unit 291 files / 4,630; web unit 185 files / 1,532; new integration scenarios (preview equals result and writes nothing; history scoped to the business with exact amounts, filters, paging and the reversal shortfall); component, action and permission tests; en/es/fr/ar.
