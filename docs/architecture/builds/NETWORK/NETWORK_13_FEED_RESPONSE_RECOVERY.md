# NETWORK-13 — Closed Feed response validation and recovery

## Reconciliation and authority

Authoritative main: `d83a08a741ab9e3b1ee0ff18b82870d03c37e060` (#544).
NETWORK-12 #540 is merged (main merge `08c61cd`), as are COMMUNITY-01 and
NETWORK-01 through NETWORK-11. Their implementation and regression coverage
are preserved. No open PR or formal next NETWORK-13 product specification was
found at reconciliation. Proposed engagement features are not authorization.

The current continuation directive explicitly authorizes an independently
justified existing-Community reliability correction when no approved feature is
ready. This block repairs the already documented contract that failed Feed reads
must be recoverable and must never masquerade as an empty Feed. No new publishing,
audience, identity, content or engagement policy is introduced.

## Demonstrated gap

`getCommunityFeed` trusted a TypeScript type assertion on a successful JSON
response. Null pages, non-array items and invalid dates reached rendering,
where they could fail instead of displaying the existing retry state. The API
also passed malformed continuation values from its source without validation.

Before correction: four new frontend regressions and three new API regressions
failed against main. The API's 26 other tests and frontend's 13 other tests
passed. These are executable failures, not a hypothetical new feature.

## Approved scope and acceptance criteria

1. Validate the existing closed Feed item/page DTO at the API and web read
   boundaries using one shared schema. No new field or permission.
2. Preserve existing handle, content class, body bound, nullable values, https
   links, parseable publication date, opaque cursor and maximum page size.
   Respect the requested page size at each read boundary.
3. Strip unknown/internal fields. Never echo validation details or raw payloads.
4. Invalid source output becomes the existing generic API 503. A malformed web
   success response becomes `unavailable`, using existing retry/latest controls.
5. Preserve customer login/refresh control flow, forbidden results, cursor, locale,
   feature flag, moderation authority, expiry and existing publication controls.
6. Demonstrate recovery from malformed items, dates and cursor values through
   the real customer page, at 375px/1280px in English and Arabic/RTL.
7. Preserve NETWORK-11 pin/audit and NETWORK-12 precision/order regressions.
   Complete actual typecheck, lint, units, PostgreSQL, build and exact-head CI.

## Implementation

The shared `network-feed` schema projects only the established customer fields.
API Feed item/page aliases and web DTO aliases use that same definition. The
existing source port, query predicate, endpoint paths, page sizes and customer
response shape are unchanged. Existing reserved `business_post` DTO typing does
not activate a business publisher or change the official-only storage constraint.

The API parses a complete page before returning it and retains its generic error
handler and source release. The web parses unknown success data before giving
it to the view. Parsing failures use existing `unavailable`; redirects are still
re-thrown and 403 still maps to `forbidden`. No partial invalid page is rendered.
Published strings are validated without rewriting link/body content.

No production view or localized copy change is needed: the established error,
retry, empty, latest and refresh-pending states already exist. Shared validation
restores those flows instead of creating another UI or navigation destination.

## Browser and security evidence design

Synthetic posts still pass through the real author, submit and two-distinct-
approver API. JWT checks, current-role queries, transactions, publication triggers
and audit middleware stay real. A test-only transport seam corrupts a Feed payload
only AFTER the real API has returned an authenticated successful GET; it cannot
replace a 401/403/404. No production bypass or endpoint is added.

The customer-only context has no staff cookies. English/Arabic and mobile/desktop
cases verify the same cursor survives retry, no content is shown on invalid data,
the empty state is not fabricated, raw private details are absent, healthy retry
restores the published page, keyboard focus and 44px controls work, and no horizontal
overflow occurs. Existing authorization, session expiry/revocation, flag and
moderation scenarios remain in the dedicated workflow.

## Identity compatibility and policy boundary

This block delegates all customer authentication to unchanged `customerApiFetch`
and API middleware. It adds no OTP, password, registration or verification flow.
It is compatible with a future password-authenticated customer session following
the same existing read contract. CUSTOMER-AUTH-UX-01 is not imported or implemented.

Current main still explicitly gates Network Feed reads on authoritative verified-
phone status (CUSTOMER-PHONE-01 and NETWORK-08). Basic viewing versus higher-trust
engagement therefore needs an explicit eligibility reconciliation with the Owner's
progressive-verification direction. That policy issue is recorded, not silently
resolved by removing a server guard in this reliability PR. No additional phone
verification friction is introduced; existing membership/points access is untouched.

## Isolation and migration governance

No migration, journal, schema, credential, feature-default, shared-resource or
infrastructure change. Current main includes 0085/0086; both remain unchanged.
PostgreSQL and R21 checks use fresh disposable loopback fixtures only. No production
or staging connection is made. No cashier, R8-G/D2, billing, B2B or identity
implementation is modified. The single Community entry and separate business
loyalty/Community Points accounting remain unchanged.

## Roadmap and final gate

The official publishing, draft recovery, moderation/history, refresh, pinning and
precise Feed pagination blocks are MERGED. Their runtime quality is verified by
tests, not merely by page presence. NETWORK-13 is IMPLEMENTED BUT NOT MERGED until
owner review. Business publishing remains gated by Network eligibility/permissions
and integration decisions despite existing BDPN foundations. Follows, reports,
customer posts, notifications, advertising and points incentives remain proposed,
NOT IMPLEMENTED by this block.

Completion requires all acceptance criteria, real PostgreSQL and browser execution,
green exact-head hosted CI, clean mergeability and no unresolved blocking review
comments. Exact counts, skips, commit mapping and any environment limitations are
recorded in the draft PR/final report. No automatic merge, deployment or next block.
