# COMMUNITY-01 — Community tab integration and Feed foundation

**Status:** development and testing only. Not deployed, not activated, no migration. Baseline `origin/main` @ `e2bc839` (PR #468 and #469 merged).
Customer promise: *One account. Every loyalty.* Community is not a marketplace.

## 1. Reconciliation (what existed)
| Area | Finding |
|---|---|
| Navigation | One customer entry `Community` → `/loyalty/dashboard/community` already existed (H1/H2). Other entries untouched (Rewards, Surveys, QR, Settlements, Support). |
| Points & Membership | Implemented read-only in `community/page.tsx` + `community-hub-view.tsx` over existing `GET /community/me` and `GET /community-points/me/transactions`. Community Points are a separate ledger from business loyalty points. **Reused unchanged.** |
| Feed | **Nothing implemented.** No table, endpoint or UI. NETWORK-00 is a *design proposal*; its tables, endpoints and permissions are not approved. |
| Language | Global next-intl resolution (`i18n/request.ts`, saved customer locale) applies; new strings exist in en/fr/es/ar. |
| Migrations | Latest `0076`. COMMUNITY-01 adds **none**. |

## 2. Changes
- **Navigation:** `community/layout.tsx` + `community-section-nav.tsx` add an in-page section control: `Points & Membership` (`/loyalty/dashboard/community`) and `Feed` (`/loyalty/dashboard/community/feed`, the route NETWORK-00 §0 proposes). Real links, `aria-current`, labelled `<nav>`. No new top-level entry; the sidebar item stays active for both routes (prefix match).
- **API:** `GET /network/feed` (`community/community-feed.routes.ts`): customer-authenticated, customer-keyed rate limit, strict query (`limit` 1–50, opaque `cursor`; unknown keys such as `customerId` rejected), `Cache-Control: private, no-store`, read-only (no write method). Identity comes from the session only.
- **Contract:** `community-feed.ts` defines the closed DTO (NETWORK-00 §8) and a `FeedSource` port. The **only** source shipped is `emptyFeedSource`. Contract-violating items (bad handle, non-https link, unknown class, oversized page) and source errors fail closed with a generic 503.
- **Web:** `feed/page.tsx`, `community-feed-view.tsx`, `lib/community-feed.ts`: loading (route `loading.tsx` of the dashboard), empty, error (retry preserves cursor), forbidden, cards (`article`, `time`), https-only links, cursor "Load more".

## 3. Not done on purpose (owner decisions needed)
No publication, moderation, audience eligibility or content ownership policy is approved, so nothing can be published and the feed is always empty. Needed before a real source: NETWORK-00 open questions C-1..C-5; approval of the `network_*` schema and a migration authorization; BDPN eligibility (a live published business profile) as the visibility predicate; feature-flag policy; who may author `official` content and the two-person rule. No cross-business advertising, messaging, follows, reports or customer posts were built.

## 4. Security properties
Authenticated active customers only; no client-supplied identity; no read of loyalty, points, feedback, survey, consent or messaging tables by the feed; no privileged database access (the empty source opens no database); fail closed; no cross-business exposure possible because no content exists. Gate 2 broker and CUSTOMER-AUTH-S4 recovery are untouched.

## 5. Tests
API: `community-feed.routes.test.ts` (22), mounted-worker check in `customer-route-boundaries.test.ts`. Web: section nav + layout, feed view, feed loader/cursor sanitizer, layout guard (Community appears once), existing hub tests unchanged.
