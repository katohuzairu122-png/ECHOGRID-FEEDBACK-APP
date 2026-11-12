# BDPN-01D — Community Hub Integration Design

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. No page, component, route, translation, style, test or configuration is created or
changed. H1 and H2 are not touched. Nothing here authorizes implementation, a migration, a notification, marketing, a merge or a deployment.**

- Baseline: `origin/main` @ `b2f85ac097e5c3b945dc586df046513494525705`
- Inputs: spec section 5, security document, decision record, 01A, and 01C (open PR #365) for the API contract this UI consumes. Where 01C is still a draft, the
  API names below are the proposed ones and may change with it.
- "Proposed" is a design choice for owner review. "OPEN" is a question this block surfaces and does not decide (section 10).

## 1. Decisions applied

| Decision    | Effect on the UI                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| D-09        | Signed-in customers only. The existing customer login gate applies; there is no anonymous browsing          |
| D-10        | Links and routes use the opaque `profileId`; the internal business id never appears in a URL or on screen   |
| D-12        | Every discovery request is uncached (`cache: 'no-store'`); the pages are dynamic, never statically rendered |
| D-17        | The web records nothing per customer: no view counters, no click tracking, no analytics events              |
| D-18        | Informational join wording only; no join button or action anywhere in discovery                             |
| D-20        | The entry card is shown only when the API's `status` says discovery is enabled                              |
| D-11        | Category names come localized from the API                                                                  |
| D-07 / D-05 | One optional website link; no images, so no media layout                                                    |

## 2. Where it lives (no new top-level navigation)

| Item             | Proposal                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entry            | A **"Discover businesses" card on the Community Hub page** (`/loyalty/dashboard/community`), placed between the membership and points cards and the ledger. It links to the list. It appears only when discovery is enabled, and it appears **for every signed-in customer**, whether or not they are a Community member |
| List             | `/loyalty/dashboard/community/businesses`                                                                                                                                                                                                                                                                                |
| Detail           | `/loyalty/dashboard/community/businesses/[profileId]`                                                                                                                                                                                                                                                                    |
| Navigation       | The existing "Community" item stays highlighted (the routes are under `/community`). **No new sidebar or bottom-bar item.** A "Back to Community" link and a breadcrumb sit at the top of both pages                                                                                                                     |
| Layout and theme | The existing customer workspace layout and tokens (`--ws-*`); a small CSS module following the H1 conventions; no parallel palette                                                                                                                                                                                       |

The hub's membership and points sections, the Surveys module and the customer QR page are **unchanged**.

## 3. Data access in the web layer (server-side only)

- A new server-only module (design name `lib/discovery.ts`) calls the three read endpoints through the existing customer API helper, so an expired session redirects to the customer login
  exactly as the Community hub does. The browser never calls the API directly.
- Calls: the list page issues `GET /discovery/businesses` and `GET /discovery/categories` **in parallel**; the detail page issues one `GET /discovery/businesses/:profileId`. The hub entry card issues one `GET /discovery/status`.
- The web passes `locale` explicitly (resolved from the active language), because the API does not read the saved language (01C section 6).
- Results are returned as a **section state**, in the style of H1: `ready`, `unavailable` (network, 5xx, 429), `not_found` (404), with a 401 handled by the existing redirect. A failure is **never**
  converted into an empty list or an empty profile.

## 4. Screens and states

### 4.1 List (`/community/businesses`)

| Element       | Behavior                                                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Header        | Title, one-line explanation ("Businesses on Echo Grid that have published a profile."), back link                                                                                                                                                                                                                  |
| Filters       | A plain `GET` form (works without client-side JavaScript): a category `select` (first option "All categories") and a search field (label "Search by name", 2 to 64 characters). Submitting resets the cursor. The form values live in the URL (`?category=&q=`) so the page is shareable and the back button works |
| Results       | A list of cards: display name, summary, category name, location label. Each card is **one link** to the detail page (`profileId`). No images, ratings, badges, "popular" marks, distances or counts                                                                                                                |
| Paging        | **Forward-only** "Show more" link carrying the `cursor` (keyset paging has no "previous"); a "Back to the start" link when a cursor is present. The browser back button returns to the previous page                                                                                                               |
| Language note | When a card's `contentLocale` differs from the active language, a small label shows the language the text is in, so a mixed-language list is understandable                                                                                                                                                        |

States (each is a separate screen state with its own copy, never conflated):

| State         | Condition                                                 | Copy intent                                                                    |
| ------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Loading       | Route transition                                          | Skeleton rows via the route's loading boundary                                 |
| List          | Items returned                                            | The cards above                                                                |
| None yet      | No discoverable business and no filter                    | "No businesses have published a profile yet."                                  |
| No match      | Filters applied, nothing returned                         | "No businesses match your search." plus a "Clear filters" link                 |
| Invalid input | The API returned 400 (for example a one-character search) | An inline message at the field; the previous results are not shown as if valid |
| Unavailable   | Network error, 5xx or 429                                 | "Businesses could not be loaded right now." plus a "Try again" link (same URL) |
| Signed out    | 401                                                       | Redirect to the customer login (existing behavior)                             |
| Not enabled   | Discovery switched off                                    | The route behaves as not found; the entry card is hidden                       |

### 4.2 Detail (`/community/businesses/[profileId]`)

| Element             | Behavior                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Content             | Display name (the page `h1`), category name, summary, description (plain text; line breaks preserved with `white-space: pre-line`), the list of locations (label, city, region, country; street address only if provided), the website link, "Published on <date>" |
| Website link        | Shows the hostname as the link text; opens in a new tab with `rel="noopener noreferrer nofollow"`; a visually hidden "(opens in a new tab)"; a short notice "You are leaving Echo Grid" is **not** a modal, only a line of text near the link                      |
| Join wording (D-18) | One informational paragraph: "If this business offers a rewards program, you can join it by scanning the business's QR code when you visit." It does **not** claim the business has a program, and it contains **no** button or link that starts joining           |
| No actions          | No follow, save, share, message, contact-us form, "claim reward" or "join" control                                                                                                                                                                                 |
| Not found           | A single "This business could not be found" screen for every cause (unknown, unpublished, suspended, withdrawn, disabled) with a link back to the list                                                                                                             |
| Unavailable         | The same retry pattern as the list                                                                                                                                                                                                                                 |

## 5. Relationship to other modules (non-effects are acceptance criteria)

| Module                    | Rule                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Community Hub H1          | The entry card is the **only** change to the hub page. Membership and points data are neither read nor shown by discovery. A non-member can use discovery |
| Surveys H2                | No coupling; no survey link on a profile                                                                                                                  |
| Loyalty and rewards       | No loyalty read or write. Viewing a profile never joins, checks in, or opens a loyalty account                                                            |
| Customer QR               | Unchanged                                                                                                                                                 |
| Language selector         | Unchanged. Discovery text follows the active language; profile content follows the per-field fallback shown in the response                               |
| Notifications and consent | **None created, read or changed.** The only data the page needs from the customer is their session                                                        |

**Binding non-effects:** browsing creates no membership, loyalty account, consent grant, Community Points movement, notification, message, view history or advertising event.

## 6. Language, direction and accessibility

- All page chrome comes from a new translation namespace (design name `loyalty.customer.discovery`) in `en, fr, es, ar`, with the same quality bar as the existing modules. The key groups are:
  `title`, `intro`, `back`, `filters` (category label, all-categories option, search label and hint, submit, clear), `states` (none, noMatch, invalid, unavailable, notFound, notEnabled with retry labels),
  `card` (language label), `detail` (publishedOn, location headings, website label, leaving note, joinInfo), and the hub `entry` card (title, description, cta).
- **Arabic:** the layout uses logical CSS properties (start and end, not left and right); the page direction comes from the active locale as elsewhere; mixed-direction text (an English business name inside an Arabic page) is isolated so punctuation does not jump. Profile text is rendered in its own language
  attribute (`lang` set from `contentLocale`) so screen readers pronounce it correctly.
- **Accessibility:** one `h1` per page; the results are a real list; filter controls have visible labels; the search form is reachable by keyboard and submits on Enter; focus moves to the results heading after a filter submit
  and to the error message after an error; every interactive target is at least 44 px; colors come from the existing tokens and are checked for contrast by measurement (the method used for H1), at both light and dark workspace themes; the external-link notice is text, not color alone.
- **Mobile:** a single-column list; the filter form stacks; no horizontal scrolling at 390 px.
- **No client-side state:** the pages are server-rendered; the only client JavaScript is whatever the existing layout already ships. Nothing is stored in the browser.

## 7. Security and privacy in the UI

- Profile text is rendered as **plain text** through the framework's escaping; no raw HTML rendering anywhere in the discovery pages.
- The website link is built only from a URL the API returned and re-checked on the web side for the `https` scheme; anything else is shown as plain text, not a link.
- No profile content, search text or handle is written to browser storage, cookies or logs. Server-side logs for these pages record status and duration only (D-17).
- No third-party scripts, fonts, images or trackers are added.
- Responses are uncached; there is no service-worker caching of these routes (the existing service worker must be checked so it does not cache them: OPEN O-D1).

## 8. Test requirements (specified, not written)

| Layer                                                | Tests                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (view components)                               | Every state in section 4 renders its own copy; a failure is never rendered as empty; the card is one link; the join paragraph has no link or button; the website link has the required attributes and falls back to text for a non-https URL                                                                                                                                                                  |
| Server module                                        | Section-state mapping for 200, 400, 401 (redirect), 404, 429, 5xx and network failure; `locale` is passed; `cache: 'no-store'` is set; no customer id is logged with a handle                                                                                                                                                                                                                                 |
| Translations                                         | The existing locale-parity test passes for the new namespace; Arabic strings reviewed for direction                                                                                                                                                                                                                                                                                                           |
| Browser (real build, real API and database fixtures) | Published profile appears; an unpublished, suspended and withdrawn one do not and give the same not-found screen; filter and search; forward paging; Arabic layout at 390 and 1280 px; no horizontal overflow; keyboard-only path; contrast measured                                                                                                                                                          |
| **Non-effects proof**                                | With the real database, record row counts of `business_customer_memberships`, `loyalty_accounts`, `loyalty_transactions`, the Community points tables, `consent_grants`, `notifications` and `messages` before and after a full browse session; they must be **identical**. Capture all network requests and assert that only `GET` requests to the discovery endpoints are made (plus the page's own assets) |
| Disabled mode                                        | Switch discovery off: the entry card is gone and both routes show the not-found screen                                                                                                                                                                                                                                                                                                                        |
| Existing behavior                                    | H1 and H2 pages and tests are unchanged and still pass                                                                                                                                                                                                                                                                                                                                                        |

## 9. Dependencies and sequencing

- Requires the 01C API and the 01A schema to exist; this block designs only the UI and is **not implementable before them**.
- Requires the activation setting (D-20) so the card can be hidden.
- Requires the translation work (copy approved in four languages) and, for category names, the translated category names (decision-record item N-4).

## 10. Open questions (not decided)

| ID   | Question                  | Options                                                                                                 | Author's view                                                             |
| ---- | ------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| O-D1 | Service-worker behavior   | Confirm the existing service worker does not cache discovery routes; add an explicit bypass if it would | Verify at implementation time                                             |
| O-D2 | Language label on cards   | Show a small "in <language>" label when content falls back (proposed) or hide it                        | Show it: mixed-language lists are otherwise confusing                     |
| O-D3 | Result count text         | None (proposed, no totals per 01C) or "showing N" for the loaded page only                              | None: avoids implying completeness                                        |
| O-D4 | Search-as-you-type        | Submit-only form (proposed) or live suggestions                                                         | Submit-only: no per-keystroke requests, simpler, kinder to the rate limit |
| O-D5 | Copy of the join sentence | Wording as in section 4.2 or the owner's wording                                                        | Owner to approve all four languages                                       |

## 11. Owner gate and acceptance

- **Owner gate:** wording approval (O-D5 and all discovery copy in four languages), the activation approach (D-20), and answers to O-D1 to O-D4 where they matter.
- **Acceptance met by this document:** every state of the list and the detail is specified; discovery needs no Community membership; H1 and H2 are untouched; there is no new top-level navigation item;
  browsing has a testable no-effect guarantee; and nothing introduces a notification, consent, marketing, loyalty, Community Points, Partner Credit or billing behavior.
- No implementation block is started or authorized by this document.
