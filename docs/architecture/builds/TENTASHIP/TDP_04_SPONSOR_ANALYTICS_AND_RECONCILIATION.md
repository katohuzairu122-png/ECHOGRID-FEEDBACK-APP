# TDP-04 — Sponsor analytics, canonical inventory reconciliation and TSH-07 handoff

Status: IMPLEMENTED (read-only; no migration). Synthetic only. `TENTASHIP_DROPS_ENABLED` exact `"true"`, disabled by default, generic 404 before authentication. External sponsor access stays UNAVAILABLE until the Owner approves the sponsor permission model.

## 1. Canonical sources (no competing balance)
The single authoritative inventory row (`drop_inventory`), `drop_reservations` and the hash-chained `drop_events`. Nothing is stored by analytics.

## 2. Metrics (kind: current / historical / derived / integrity)
| Metric | Kind | Definition |
|---|---|---|
| total | current | `drop_inventory.total_quantity` (the approved version's quantity; immutable) |
| reserved | current | reservations currently `reserved` |
| allocated | current | reservations currently `allocated` |
| collected | current | reservations currently `collected` |
| allocationsExpired | current | allocated units whose collection window passed uncollected; **not returned to the pool** |
| available | current | total − reserved − allocated − collected − allocationsExpired |
| outstandingCollection | current | allocated |
| reservationsCreated | historical | every reservation ever created; the five states sum to it (activity, not a balance) |
| holdsReleased | historical | reservations in status released |
| holdsExpired | historical | `hold_expired` events |
| collectionCompletionRate | derived | collected ÷ (collected + allocated + allocationsExpired); **unavailable** (not 0) before any allocation |
| reconciled | integrity | every reconciliation check passes |
Unsupported metrics are `{available:false, reason}`; there is no revenue, ROI, incremental-sales, lifetime-value, profitability or acquisition figure. Inventory additions are unavailable: the total is immutable.

## 3. Reconciliation (`GET /platform/drops/sponsorships/:id/reconciliation`)
Read-only. 14 checks: non-negative, within total, total = approved version, reserved/allocated/collected = reservations, expired-unreturned = `allocation_expired` events, every reservation in exactly one state, released = events, expired holds = events, expired conserved, available excludes expired-unreturned, no duplicate live units, chain verifies. A failure returns expected/actual and `REVIEW_REQUIRED_NO_AUTOMATIC_REPAIR`: **nothing is repaired, adjusted or returned**. Failures become distinct read-only fraud signals (one per failed check) that an operator may turn into a governance case.

## 4. TSH-07 handoff (`GET .../event-references?afterSeq=`)
Identity-free references (event id, seq, hash, kind, time) to rows of the append-only chain; kinds: reserved, allocated, collected, released, hold_expired, allocation_expired, approved. The payload states what these are NOT evidence of: qualifying purchase, customer acquisition, revenue, return on investment, incremental sales, lifetime value, sponsor profitability. Eligibility, invitation, acceptance and participation stay in the Shuffle tables; Drops events do not duplicate them.

## 5. Authorization and privacy
Platform admin only; cashier tokens denied; no sponsor, export or write route. The sponsor-scoped service (internal) is tenant-bound (another business's sponsorship is indistinguishable from a missing one) and requires an explicit privacy threshold (no default is invented; it is neither the Business Community value nor a campaign minimum) with all-or-nothing suppression, so differencing and repeated queries cannot recover hidden values. OWNER DECISION: the TDP-04 minimum aggregation threshold and the sponsor permission keys.

## 6. Interface foundation
`SponsorshipReport` (contained, unrouted; four languages; Arabic RTL via logical classes): overview, inventory now, reservation history, allocation/collection, reconciliation, unavailable/suppressed states. No action, link or export. Verified in jsdom and in real Chromium (desktop + mobile, en/ar/es/fr) by `pnpm --filter web test:components` (fixtures rendered by `vitest.components.config.ts`, loaded by `playwright.components.config.ts`; no route, server or database).
