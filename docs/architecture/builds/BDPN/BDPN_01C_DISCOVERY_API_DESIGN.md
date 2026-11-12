# BDPN-01C — Published-Business Discovery API Design

**Status: DESIGN PROPOSAL — DOCUMENTATION ONLY. No endpoint, route, middleware, binding, shared type, schema or
configuration is created or changed. Nothing here authorizes implementation, a migration, a page, a notification,
marketing, a merge or a deployment.**

- Block: BDPN-01C (the owner's "10C", read as BDPN-01C; no other block of that name exists in the repository)
- Baseline: `origin/main` @ `b2f85ac097e5c3b945dc586df046513494525705`
- Inputs (all merged): spec (`BDPN_01_BUSINESS_PROFILE_DISCOVERY_SPEC.md`), security document, sequence document,
  decision record (`BDPN_01_OWNER_DECISION_RECORD.md`), and `BDPN_01A_DATA_CONTRACTS_AND_SCHEMA_PROPOSAL.md` (01A).
- This document **refines** spec section 4 (discovery read model). Where it differs from the spec, this document governs for
  the API. Where it needs a change to 01A, that is listed in section 12 as an amendment and is **not** applied here.
- "Proposed" is a design choice for owner review. "OPEN" is a question this block surfaces and does not decide (section 13).

## 1. Decisions applied

| Decision                                      | Effect on the API                                                                                                       |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D-09 signed-in customers only                 | Every endpoint requires the existing customer session. No anonymous read                                                |
| D-10 opaque handle                            | Public identifier is `profileId` = the 22-character `profile_handle`. `businesses.id`, slug and legal name never appear |
| D-11 translated category names                | `categoryName` is localized from the category translation table, falling back to the English name                       |
| D-12 no caching                               | `Cache-Control: private, no-store` on every response; no ETag, no epoch                                                 |
| D-17 no tracking                              | Requests are not recorded per customer; logs never pair a customer with a handle or a search term                       |
| D-20 off by default                           | An API activation setting, default off; when off the discovery data endpoints answer as "not found"                     |
| D-25 leave `/businesses/:id/public` unchanged | Discovery has its own endpoints and read model; the existing endpoint is not touched and is never a publication signal  |
| D-18 informational join text only             | No join action in any response; no link that enrolls a customer                                                         |
| D-24 plan entitlement (open follow-up)        | A reserved read-only term in the eligibility query, absent until the owner decides                                      |

## 2. Facts verified on the baseline that shape the design

| Fact                                                                                                                                                                                                                                                                                          | Where verified                              | Consequence                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Responses use the envelope `{ success, data }` or `{ success:false, error:{ code, message, details } }`                                                                                                                                                                                       | `lib/response.ts`, `lib/errors.ts`          | Discovery follows it unchanged                                                                                                        |
| `AppError` statuses are only `400 401 403 404 409 422 429 500`. **There is no 503**                                                                                                                                                                                                           | `lib/errors.ts`                             | A disabled or unavailable state cannot use 503 without changing that type. Disabled uses 404 (section 8)                              |
| `customerAuthenticate` answers **401** for a missing, invalid, expired **or inactive/suspended** customer. It never answers 403                                                                                                                                                               | `middleware/customer-authenticate.ts`       | The spec's "forbidden (customer not active)" state is, in practice, a **401**. The web treats it as signed-out (section 7)            |
| The only list-pagination helper, `parseListPagination`, is **offset-based** and its own doc says it serves staff list endpoints                                                                                                                                                               | `lib/list-pagination.ts`                    | Not reused. Discovery needs keyset pagination (section 5); its parsing rules (canonical integers, no duplicates) are copied in spirit |
| `rateLimit(binding, resolveKey?)` defaults to the `cf-connecting-ip` header. A code comment states that for Worker-to-Worker calls this "may identify the web Worker rather than the customer", collapsing all customers into one bucket. `PUBLIC_RATE_LIMITER` is 20 requests per 60 seconds | `middleware/rate-limit.ts`, `wrangler.toml` | Discovery must **not** use the IP-keyed default. It needs its own limiter keyed by the authenticated customer (section 9)             |
| Existing customer routes call `rateLimit('PUBLIC_RATE_LIMITER')` with no key function                                                                                                                                                                                                         | e.g. `surveys/survey-customer.routes.ts`    | See the observation in section 13 (not changed by this block)                                                                         |
| There is no `*_ENABLED` style setting in `config/env.ts`; settings live in `[vars]` per environment in `wrangler.toml`                                                                                                                                                                        | `config/env.ts`, `wrangler.toml`            | An activation setting would be new, added in `[vars]` and `[env.staging.vars]`                                                        |
| The only database extension referenced anywhere is `pgcrypto` (in disposable test scripts, none in a migration); `pg_trgm` and `unaccent` appear nowhere                                                                                                                                      | `drizzle/*.sql`, Gate 2 scripts             | **No new extension in v1** (section 5). Search must work with plain SQL                                                               |
| `Cache-Control: no-store` has precedent only on one sensitive route                                                                                                                                                                                                                           | `internal/stripe-read-admin.routes.ts`      | Headers are set explicitly on discovery responses                                                                                     |
| Customer subtrees must be mounted before staff wildcard middleware                                                                                                                                                                                                                            | comment in `index.ts`                       | `/discovery` is not under any staff wildcard, but its mount position must be reviewed in implementation                               |
| No customer-facing business list exists                                                                                                                                                                                                                                                       | reconciliation, spec                        | Discovery is new, read-only, and reads only the approved-revision tables from 01A                                                     |

## 3. Endpoints (proposal)

All under one new mount, `/api/v1/discovery`, **entirely behind `customerAuthenticate`** and the discovery rate limiter.
All are `GET` and read-only. None writes any row.

| Endpoint                               | Purpose                                                                                                  | Success                           |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `GET /discovery/status`                | Tells the web whether discovery is switched on. The **only** endpoint that answers when discovery is off | 200 `{ enabled: boolean }`        |
| `GET /discovery/businesses`            | One page of discoverable businesses                                                                      | 200 `DiscoveryListDto`            |
| `GET /discovery/businesses/:profileId` | One published profile                                                                                    | 200 `DiscoveryBusinessProfileDto` |
| `GET /discovery/categories`            | Categories that currently have at least one discoverable business                                        | 200 `DiscoveryCategoryDto[]`      |

Why a status endpoint (OPEN O-C3): the activation setting (D-20) must have **one** source of truth. If the web had its own
copy, the two could disagree and the entry card could show while the API refuses. With a status endpoint the web asks the API.

### 3.1 Request contract

Parsing is strict and fail-closed: unknown query parameters, duplicated parameters, non-canonical numbers, control
characters and over-long values are rejected with a **400** before any database access.

| Parameter   | Endpoint | Rule                                                                                                                       |
| ----------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| `limit`     | list     | Canonical decimal integer, 1 to 50, default 20                                                                             |
| `cursor`    | list     | Opaque string from a previous response, at most 256 characters, validated (section 5.4)                                    |
| `category`  | list     | A category **key** (`^[a-z0-9_]{1,64}$`) that exists in the active catalog; an unknown key is a **400**, not an empty list |
| `q`         | list     | 2 to 64 characters after trim; normalized (section 5.2); `%`, `_` and `\` are escaped, never interpreted                   |
| `locale`    | all      | One of `en`, `es`, `fr`, `ar`. Optional; defaults to the business default locale, then `en` (section 6)                    |
| `profileId` | detail   | Exactly 22 characters of `[A-Za-z0-9_-]`; anything else is the same **404** as an unknown handle (no format oracle)        |

## 4. Response contract (closed allow-lists)

Each DTO is a **closed** shape: a contract test asserts the exact key set, and any extra key fails the build (security
document T-01). These refine the spec's DTOs using decisions D-06, D-07, D-10 and D-11.

```ts
// design only, proposed for packages/shared-types (a new discovery.ts); not created here
type DiscoveryLocale = 'en' | 'es' | 'fr' | 'ar';

interface DiscoveryBusinessListItemDto {
  profileId: string; // opaque handle (D-10)
  displayName: string;
  summary: string | null;
  categoryKey: string | null;
  categoryName: string | null; // localized (D-11)
  locationLabel: string | null; // first public location label, if any
  contentLocale: DiscoveryLocale; // locale the displayName was served in
}

interface DiscoveryBusinessProfileDto extends DiscoveryBusinessListItemDto {
  description: string | null;
  websiteUrl: string | null; // https only; the only public contact field in v1 (D-07)
  locations: {
    kind: 'place' | 'service_area';
    label: string;
    city: string | null;
    region: string | null;
    countryCode: string | null;
    streetAddress: string | null; // only if the business opted in
  }[];
  fieldLocales: {
    displayName: DiscoveryLocale;
    summary: DiscoveryLocale | null;
    description: DiscoveryLocale | null;
  };
  publishedAt: string; // ISO timestamp
}

interface DiscoveryListDto {
  items: DiscoveryBusinessListItemDto[];
  nextCursor: string | null; // no total count
}

interface DiscoveryCategoryDto {
  key: string;
  name: string; // localized (D-11)
}
```

**Explicitly absent from every discovery response** (a contract test asserts it): `businesses.id`, `slug`, legal name, any
branch id or coordinate, any customer or loyalty data, Community Points, Partner Credit or billing data, plan or
entitlement information, review reason or moderation notes, reviewer or submitter identity, revision ids, content digest,
publication state values, ratings, reach, popularity, proximity, opening status, offers, sponsored flags, logo or media URLs
(no media in v1, D-05), phone or email (D-07), and **category counts** (O-C6).

## 5. Query semantics

### 5.1 Eligibility

Every list, detail and category query is built on the single **eligibility predicate** in 01A section 6 (published state,
approved revision of the same business, active and non-deleted business, default-locale translation present, plus the
reserved plan term). It is evaluated **in the query**, never from a stored flag. Any inconsistency yields no row.

### 5.2 Search normalization

Search text and the stored comparison value must be produced by the **same function**, or matching is unpredictable:
Unicode NFKC, then case folding, then removal of combining marks (accents) and collapse of runs of whitespace to one
space. The function must be specified with test vectors for `en`, `fr`, `es` and `ar` (including Arabic diacritics and
presentation forms). The stored value is computed **once, by the application, when a draft is saved**, so it is frozen
with the revision (**amendment A-1 to 01A**, section 12). Matching is a **substring match on the normalized display name
only**; it never reads description, website, location or any private column. `%`, `_` and `\` are escaped.

### 5.3 Ordering and the page query

- **Deterministic order:** normalized **default-locale** display name ascending, then `profileId` ascending. No ranking,
  boosting, randomization, recency or popularity (spec 4.3 and R2).
- **Why the default-locale name** (OPEN O-C2): sorting by the displayed, per-request-locale name would need a per-row
  fallback expression that no index can serve and that would reorder the same data differently per language. Sorting by the
  default-locale name is stable, cheap and indexable. The displayed text can still be in the requested locale.
- **Keyset predicate** (illustrative): `(sort_key, profile_id) > (:cursorKey, :cursorId)` with `ORDER BY sort_key, profile_id`,
  fetching `limit + 1` rows to compute `nextCursor` without a count.
- **Consistency:** if a business is published or unpublished between two page requests, the walk stays valid (no
  duplicated or skipped _stable_ items); a business changing visibility mid-walk may appear or vanish. This is acceptable and stated.
- **No new database extension in v1.** At the expected scale a plain normalized-substring scan over published rows is
  sufficient. If the published set grows enough that the scan is slow, a trigram index (which requires `pg_trgm`, unused
  today and to be verified on disposable PostgreSQL 18 first) is a later, separately authorized change.

### 5.4 Cursor

- Format: base64url of a small JSON object `{ v: 1, k: <sortKey>, h: <profileId> }`, at most 256 characters.
- The cursor is **untrusted input**. It is decoded and validated (version, types, handle format, key length) and a failure is
  a **400**. A forged cursor can only move the page position over data the caller may already read, so it carries no authority.
- Signing the cursor would need a new secret binding; it is **not proposed** for v1 (OPEN O-C1).
- A cursor never contains a customer id, a business id or a timestamp.

## 6. Multilingual behavior

- The API **does not read the customer's saved language**. The saved-language column belongs to migration `0067`, which is
  merged but **not applied** anywhere, so discovery must not depend on it. The web resolves the language (saved preference,
  cookie, business default, English) and passes `locale`.
- Resolution is **per field**: requested locale, then the business default locale, then `en`. `fieldLocales` reports the
  locale each text field actually came from, and `contentLocale` reports the display name's locale.
- A profile without its default-locale translation is not discoverable (01A section 6), so a display name always resolves.
- `categoryName` uses the category translation for the resolved locale and falls back to the existing English `name`.
- Text is **never machine-translated**. Right-to-left layout is a presentation concern for BDPN-01D.

## 7. States and errors

| Situation                                                       | HTTP | `error.code` (proposed)                                                       | Web state (BDPN-01D)                    |
| --------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------- | --------------------------------------- |
| Success with items                                              | 200  | n/a                                                                           | List                                    |
| Success, no discoverable businesses at all                      | 200  | n/a (`items: []`, no filter)                                                  | "None yet"                              |
| Success, filters matched nothing                                | 200  | n/a (`items: []`, filter present)                                             | "No match"                              |
| Missing, invalid, expired, **or inactive** customer             | 401  | `UNAUTHENTICATED` (existing)                                                  | Signed-out, goes to login               |
| Bad parameter, cursor or search text                            | 400  | `VALIDATION_ERROR` (existing)                                                 | Inline message, no retry loop           |
| Unknown, unpublished, suspended, withdrawn or ineligible handle | 404  | `DISCOVERY_NOT_FOUND`                                                         | "Not found" (identical for every cause) |
| Discovery switched off                                          | 404  | `DISCOVERY_NOT_FOUND` on data endpoints; `status` answers `{ enabled:false }` | Entry card hidden                       |
| Rate limited                                                    | 429  | `RATE_LIMITED` (existing)                                                     | "Try again shortly"                     |
| Server or database failure                                      | 500  | existing generic handler                                                      | "Could not load, retry"                 |

Notes: (1) the spec's separate "forbidden" state does not exist at the API, because inactive customers get 401 (section 2);
(2) a failure is **never** rendered as an empty list; (3) the unknown, unpublished and suspended causes are
indistinguishable by status, body and (as far as practical) timing, to remove a state oracle (T-08).

## 8. Activation (D-20)

- A new `[vars]` setting, proposed name `DISCOVERY_ENABLED`, default `"false"` in every environment, set per environment by
  the owner. Its introduction touches `wrangler.toml`, `[env.staging.vars]` and the `Bindings` type, and needs an
  environment-parity check as for other bindings.
- When off: `status` returns `{ enabled:false }`; the three data endpoints return the uniform 404 above; no query runs.
- "Internal testing first, then everyone" (D-20) needs a way to enable discovery for **named internal accounts only**.
  The simplest safe mechanism is to enable it **per environment** (staging first, then production) and to verify with
  staging data; a per-account allow-list is more machinery and is **not proposed** (OPEN O-C7).

## 9. Rate limiting and abuse controls

| Control           | Proposal                                                                                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Limiter           | A **new dedicated limiter** (proposed `DISCOVERY_RATE_LIMITER`), not `PUBLIC_RATE_LIMITER`, so browsing does not consume other public traffic's budget                                                                                                                                                                        |
| Key               | The authenticated **customer id**, never the IP (the IP can identify the web Worker, section 2). The key resolver needs the verified customer id; the existing `resolveKey` receives only the request, so implementation either reads the verified identity from context or extends the middleware slightly. Not decided here |
| Numbers           | The limit and period are **owner or operations decisions** (Cloudflare accepts a 10 or 60 second period). The author suggests a starting point of 60 requests per 60 seconds per customer, to be tuned with real data (OPEN O-C4)                                                                                             |
| Enumeration       | Opaque handles; cursor-only pagination; **no total count**; hard page cap of 50; minimum search length 2; uniform 404; handle format checked before any query; no endpoint returns another business's customers or a list of ids                                                                                              |
| Expensive queries | Maximum search length 64; one substring filter only; a database statement timeout for these queries; no sort options                                                                                                                                                                                                          |
| Logging           | Log status codes and durations only. **Never log the search text or pair a customer id with a handle** (D-17). Log the search length at most                                                                                                                                                                                  |

## 10. Headers

Every response, including errors: `Cache-Control: private, no-store`, `Vary: Authorization`, `X-Content-Type-Options: nosniff`.
No `ETag` or `Last-Modified`. This is the whole of the caching design for v1 (D-12): an unpublished profile is unreachable on the next
request.

## 11. Test requirements (specified, not written)

| Test                                                                                                                                                                                                                               | Threat or rule covered |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| DTO exact-key-set contract tests for all four shapes, and a test that none of the "explicitly absent" fields can appear                                                                                                            | T-01                   |
| Equality test: two customers with very different histories receive identical lists and details                                                                                                                                     | T-17, R2               |
| A business that is unpublished, withdrawn, suspended, soft-deleted or `suspended` status is absent from list, detail and categories on the very next request, with no change to profile rows when only `businesses.status` changed | T-15, T-10             |
| An unpublished business resolves through `GET /businesses/:id/public` but **not** through discovery                                                                                                                                | T-16, D-25             |
| Unknown, unpublished, suspended and withdrawn handles produce identical status and body                                                                                                                                            | T-08                   |
| Parameter fuzzing: unknown or duplicate parameters, non-canonical numbers, control characters, over-length, wildcard characters, forged and oversized cursors, all rejected with 400 before the database                           | T-08, T-19             |
| Keyset pagination: no duplicates or gaps over a stable set; concurrent publish and unpublish between pages                                                                                                                         | section 5.3            |
| Locale fallback per field, partial translations, category name fallback, Arabic normalization vectors                                                                                                                              | section 6, T-20        |
| Rate limit keyed by customer, shown **not** to collapse different customers into one bucket under Worker-to-Worker calls                                                                                                           | section 9              |
| Header tests on success and error responses                                                                                                                                                                                        | T-10                   |
| Disabled mode: data endpoints 404, `status` false, no database query executed                                                                                                                                                      | D-20                   |
| A discovery request creates no row in `notifications`, `consent_grants`, `business_customer_memberships`, `loyalty_accounts` or any points table                                                                                   | R4, R5                 |

## 12. Amendments proposed to 01A (not applied)

| ID  | Amendment                                                                                                                                                                                                              | Reason                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A-1 | Add `display_name_normalized text NOT NULL` to `business_profile_revision_translations`, computed by the application per section 5.2, immutable with the revision, and an index on `(locale, display_name_normalized)` | Deterministic, collation-independent ordering and search; supports prefix scans; frozen with the revision |
| A-2 | Add a database `CHECK` that `display_name_normalized` is non-empty                                                                                                                                                     | Prevents an empty sort key                                                                                |
| A-3 | None to the five-table list: the design needs no new table                                                                                                                                                             |                                                                                                           |

The owner must approve these before BDPN-01A's schema is implemented.

## 13. Open questions and an observation

| ID   | Question                        | Options                                                          | Author's view                                                               |
| ---- | ------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| O-C1 | Sign the cursor                 | Unsigned and validated (proposed) or signed with a new secret    | Unsigned: it grants no authority, and a new secret adds configuration risk  |
| O-C2 | Sort key                        | Default-locale name (proposed) or the displayed name             | Default-locale name: stable and indexable                                   |
| O-C3 | Where "is discovery on" lives   | A status endpoint (proposed) or a copy in the web                | Status endpoint: one source of truth                                        |
| O-C4 | Rate-limit numbers and period   | Starting suggestion 60 per 60 seconds per customer               | Owner or operations decision                                                |
| O-C5 | Search scope                    | Display name only (proposed) or also the localized category name | Display name only: simplest and cheapest; category filtering already exists |
| O-C6 | Category counts in `categories` | Omit (proposed) or include                                       | Omit: counts reveal catalog size and are not needed                         |
| O-C7 | Internal testing mechanism      | Per environment (proposed) or per-account allow-list             | Per environment                                                             |

**Observation outside this block (not changed, not verified in production).** Existing customer endpoints call
`rateLimit('PUBLIC_RATE_LIMITER')` with the default IP key, and a code comment in the middleware says Worker-to-Worker calls can make
all customers share one key. If that is also true in production, customers could be limited collectively. This is an existing
behavior to check with operations; it is **not** changed by BDPN and is the reason discovery keys by customer.

## 14. Owner gate and acceptance

- **Owner gate:** answers to O-C1 to O-C7 where they matter, approval of amendment A-1, and the activation approach (D-20).
- **Acceptance criteria met by this document:**
  - the contract can be implemented reading only the approved-revision tables and the category tables, with no private table;
  - every decision it depends on (D-09, D-10, D-11, D-12, D-17, D-25) is recorded as decided;
  - the contract passes the security document's T-01, T-08, T-10, T-15, T-16 and T-17 reviews on paper;
  - it introduces no consent, notification, promotional, loyalty, Community Points, Partner Credit or billing behavior.
- BDPN-01B, 01D and 01E are **not started** and still need their own explicit authorization.
