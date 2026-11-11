# UI Phase 2B — Feedback Inbox visual alignment

Presentation only. No new API endpoints; no change to API contracts, RBAC, sessions, tenant/branch scoping, Neon/Cloudflare/Hyperdrive/Stripe/auth/migrations, landing, Business Overview, loyalty or financial controls.

## Changes (apps/web/src/app/dashboard/feedback)
- Scoped `feedback-inbox.module.css` built only on the Phase 1 `--ws-*` / `--color-*` tokens (glass toolbar, pill saved views with horizontal scroll, urgency-accented cards, sticky bulk bar, 44px targets, reduced-motion safe skeleton).
- Header: eyebrow (business), title, "Manage forms" (was hard-coded English, now translated) and a labelled branch filter.
- Saved views: labelled `nav` ("Saved views"), one `aria-current`, params preserved as before.
- Filters: `role="search"` landmark, same query-building behaviour (search/category/urgency, offset reset, other params preserved).
- Cards: status, urgency, **sentiment**, category, assignment and rating shown as separate labelled fields (screen-reader prefixes), using only existing `FeedbackDto` fields. Sentiment is displayed only when the API provides a classified value; `pending`/`failed` analysis shows its real state; null/`unknown` shows nothing. Real `createdAt` in a `<time>` element; branch name from the caller's own branch list.
- Retained controls (all pre-existing): per-row Mark reviewed and Delete (confirm unchanged), select all/row, bulk Assign to me, bulk Mark reviewed, clear selection, Newer/Older paging.
- States: route `loading.tsx`; explicit unavailable (retry) and forbidden states instead of an unhandled error (401 still redirects to login); distinct "no feedback yet" vs "no feedback matches these filters" (with clear action).
- i18n: new keys in en/fr/es/ar (ICU plural for the page count).

## Not present in the product, therefore NOT added
There is no feedback detail route, no reply composer and no single-item assignment/status-picker in the current code. None was invented. Existing authorization is unchanged (the UI shows exactly the controls that existed).

## Material deviations from the references
1. No Feedback Inbox mockup exists in the supplied references (ECHO_4–8 cover community hub, rewards, campaigns, etc., several in light mode). The dark inbox is derived from ECHO_4's dark treatment, the production landing identity and the Phase 1 theme. Comparison was by eye; no pixel-diff tooling.
2. Mockup KPI tiles, trends, credits and recommendation widgets are not reproduced (no API data; directive forbids fabrication).
3. Filter controls remain native `<select multiple>` (accessible, unchanged behaviour) restyled with tokens, not a custom combobox.
4. The branch filter still resets other query params on change (pre-existing behaviour, left as is).
