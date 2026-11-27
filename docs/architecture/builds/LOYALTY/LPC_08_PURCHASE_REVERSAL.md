# LPC-08: purchase reversal (refund or mistaken receipt)

Status: implemented (API), validation pending Owner merge. No migration, no deployment, no feature activation. No web screen yet (open).

## Owner rulings that govern this block
1. A reward already handed over stays given; the reversal still reverses the purchase, points and progress, and is **flagged for review**. Nothing is clawed back automatically.
2. The points balance **stops at zero**; the points that could not be taken back are recorded (the shortfall).
3. **Owner and managers** reverse (permission `loyalty:adjust`, business-wide, with a required reason). A cashier cannot: the route is not on the cashier route allow-list.

## API
`POST /loyalty/purchases/:purchaseEventId/reverse` with `{ "reason": "..." }` (3 to 200 characters). Audited as `loyalty.purchase_reversed` (points reversed, shortfall, rewards revoked, entitlement ids already used). Response: points reversed, shortfall, rewards revoked, rewards already used, `needsReview`.

## What happens, in one transaction
1. The purchase event is marked `reversed` by a conditional update (exactly one caller wins; a second attempt gets `PURCHASE_ALREADY_REVERSED`; another business or an unknown id gets `PURCHASE_NOT_FOUND`).
2. The account row is locked. The points the purchase earned are taken back with a negative ledger `adjustment` (note names the purchase and the reason; programme provenance kept), limited to the current balance; the tier is recomputed by the normal earning path.
3. Programme progress (LP-01, LP-04, LP-05, LP-07): progress is derived again from the recorded history **without** this purchase, using the same pure engines that applied it live and the configuration version each event was applied under. Rewards the history no longer supports are set to `reversed` if unused; an already-redeemed one is left as is and reported. A `reversed` progress event is appended (history is never rewritten).
4. **Safety check:** before changing anything the history must reproduce the stored counters exactly; otherwise the reversal is refused (`PROGRESS_REPLAY_MISMATCH`, nothing changed) and the Owner adjusts manually.

## Known limits (stated, not hidden)
- Only events that were recorded as applied are replayed. An event that changed nothing when it happened (for example a second visit in the same streak week) was never recorded and stays a no-op, so reversing an earlier event in that week can leave the streak slightly lower than a full re-evaluation would. It never grants more than the live run did.
- A programme that was switched away from (frozen progress) is not changed; it is reported as frozen.
- Points programmes (LP-02, LP-03, LP-06) have no progress to undo; only the points are reversed.
- Check-in points are not reversible here (only purchases).
- A web screen for the Owner is a separate block.

## Verification
API unit 292 files / 4,617 tests; full PostgreSQL integration run (see PR); 8 new integration scenarios (points, shortfall, tenant, race, LP-01 revoke and reopen, LP-01 used reward flagged, LP-04 rung, replay mismatch refused) and 4 pure replay tests.
