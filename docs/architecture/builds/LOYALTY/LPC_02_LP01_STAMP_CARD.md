# LPC-02: LP-01 Buy X, get Y free (digital stamp card)

**Status: IMPLEMENTED, VALIDATION PENDING (local disposable PostgreSQL 16, unit suites, restricted runtime role; hosted CI not yet run).** Stacked on LPC-01 (migration 0107; this block adds NO migration). Development only.

## Behaviour (RW-D4)
- **One stamp per verified receipt.** The stamp key is the purchase event id; the unique `(programme, source key)` index makes a replay a no-op. The engine adds at most one stamp per receipt. Receipt time is the server's recorded `occurred_at`; no caller can supply it.
- **Configuration:** `stampThreshold` (2 to 50), `rewardId` (an ACTIVE free-item reward, RW-03, of the same business, checked on every save, validation and activation), optional `minimumPurchaseAmount` (currency precision), **`stampExpiryDays` (a number, or `null` for "never", stated explicitly)** and **`resetPolicy: on_completion`** (required). Expiry and reset can never be left to a default.
- **Completion:** the stamp that reaches the threshold creates ONE single-use entitlement (`cycle:N`) for the configured reward and restarts the card from zero; each completed card is kept in the progress history.
- **Expiry:** measured from the first stamp of the card; when passed, the stamps are discarded (recorded as an `expired` progress event) before the new receipt counts.
- **Concurrency:** progress is updated under a row lock; seven racing receipts on a three-stamp card always give two completed cards, one stamp and exactly two entitlements.
- **Entitlement redemption primitive:** `consumeEntitlement` is atomic, business-bound and single use (a double-redemption race has one winner; the database refuses to reopen or delete a used entitlement).
- **Switching away** freezes the card (stamps and entitlements kept, never converted to points); re-activating the programme resumes it.
- A stamp programme earns **no points**; the purchase is still recorded with zero points and programme provenance.

## Not complete yet (recorded honestly)
- **Reversal.** No purchase-reversal path exists in the platform today (the purchase event has `refunded` and `reversed` states but nothing sets them). LP-01 reversal handling (remove an uncompleted stamp; reverse an available entitlement; refuse an already redeemed one without inventing a forfeiture policy) is delivered together with a platform reversal service in a later block.
- **Cashier redemption of an entitlement** (surfacing it in Redeem and the customer card) belongs to the cashier and customer integration block.
- **Owner decisions still open:** how a customer is re-enrolled after a switch (stamps begin on the first qualifying receipt until the re-onboarding model is cited), and the platform stacking text.
