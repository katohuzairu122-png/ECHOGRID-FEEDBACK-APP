# Community Hub H1 — customer, read-only

Route: `/loyalty/dashboard/community` (customer workspace, behind the existing customer-cookie layout gate).
Scope: presentation of existing authenticated customer data. **No** new endpoints, migrations, backend or production configuration changes. Financial activation: NO-GO.

## Owner decisions applied
- D1: read-only display of membership status, Community Points balance and ledger history. Nothing creates, changes or redeems points.
- D2: **Community** added to the customer navigation (after "My Rewards"). Existing destinations kept: Customer QR, Orphan settlements, Support, Logout. Bottom bar (mobile): My Rewards, Community, My customer QR, More (Orphan settlements, Support, Logout). **No Surveys destination** until a working Surveys interface exists.
- D4: nothing here writes; no adjustment UI.
- D5: existing endpoints and DTOs only.

## Verified data path (before implementation)
| Need | Endpoint (existing, customer-authenticated GET) | Notes |
|---|---|---|
| Membership + points account | `GET /community/me` | `{ membership \| null, account \| null }`; membership status `active\|left\|suspended`; account status `active\|suspended\|closed`. |
| Ledger | `GET /community-points/me/transactions?limit&offset` | limit 1–200 (UI uses 20), offset ≥ 0, **no total count**; entries `{ id, type, points, sourceType, businessId, branchId, reversalOf, createdAt }`. |
| Not called | `GET /community-points/me` | Reads the same account row as `/community/me` (`findByCustomerId`); omitted to avoid an extra request against the customer rate limit (`PUBLIC_RATE_LIMITER`, 20 req/min locally). |
| Business names (optional) | `GET /businesses/:id/public` | Existing public endpoint; names that fail to load are simply omitted. |
Auth: `customerAuthenticate` (customer JWT, active customer) + `PUBLIC_RATE_LIMITER`. The web uses `customerApiFetch`, which redirects to `/loyalty/login` on 401. No feature gate is visible in the route code; **production availability of Community was not inferred** and is not established by this change.

## States (all verified with fixtures)
- Membership absent → "Not a member"; no balance shown; "No Community Points account has been recorded for you yet." Never shown as an active member with zero points.
- Active with balance `0` → "0" (a real balance), distinct from unavailable.
- Left / suspended → status and recorded date; suspended points account shows a warning and the recorded balance.
- Section failures (403 forbidden, 429/5xx/network unavailable) → explicit per-section notice with "Try again"; never rendered as zero or empty. 401 → customer login.
- Ledger: signed points as recorded (the API's sign rules: earn positive; redeem/reverse/expire negative), type and source labels, real timestamps, business name when resolvable, reversal note, newer/older paging by API offset.

## Deviations from ECHO_4 / ECHO_5 (with reasons)
1. Mockup figures not reproduced ("+320 vs last month", surveys completed, partner businesses): no data source; directive forbids invented metrics.
2. No "View rewards" button, Discover/Surveys/Rewards/Activity tabs, featured businesses, active surveys or available rewards: Surveys and rewards-redemption destinations do not exist yet (D2); no catalog data.
3. No photography/illustrations; icons only.
4. Informational "About" panels are factual descriptions of what the page does, not promotional content.
5. Light theme: the shared token scheme is preserved; the mockups ECHO_5/ECHO_8 are light but only dark is selectable today.

## Known limitations
- **Locale:** customers have no language preference in the current architecture; customer pages without a staff session render in the default locale (English). The translations (en/fr/es/ar) exist and were verified with a staff-session harness only. Selecting a customer locale needs a separate decision.
- Join/Leave and any consent flow are intentionally absent (separate consent-reviewed step).
- No ledger total count exists, so "Older" appears whenever a full page is returned.
