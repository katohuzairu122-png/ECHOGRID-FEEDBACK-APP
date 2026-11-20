# NETWORK-12 — Feed cursor reliability

## Authoritative reconciliation and selected scope

Main: `5ecb618a6e3b6091a9bcc9f9be19fa1d838df9a5` (latest PR #537).
COMMUNITY-01 and NETWORK-01 through NETWORK-11 are merged ancestors, not new
implementation scope. No formally defined NETWORK-12 or open Community PR was
found. The remaining NETWORK-00 roadmap is a proposal, not authority to add
follows, business publishing, customer posts, reports, advertising or rewards.

This block labels a narrowly scoped correction to the already approved Feed
pagination requirement. The current continuation directive authorizes necessary
Community reliability corrections. It adds no product policy or engagement API.
Branches and open PRs were checked; #538 runtime-role and #539 privacy lifecycle
are separate workstreams and are neither copied nor dependencies of this branch.

## Merged baseline

| Capability | Classification | Repository evidence |
| --- | --- | --- |
| One Community tab, internal sections | MERGED | COMMUNITY-01 #470; customer Community layout/nav, Feed and Points & Membership pages |
| Official publishing and Feed read model | MERGED | NETWORK-01 #474; migration 0077; network post service, FeedSource and customer routes |
| Platform moderation workspace | MERGED | NETWORK-02 #479; platform routes and workspace Server Actions |
| Moderation history | MERGED | NETWORK-03 #497; bounded closed audit read contract and history page |
| Original-author saved drafts | MERGED | NETWORK-04 #500; saved-draft API/page and existing editor restoration |
| Draft-to-publication verification | MERGED | NETWORK-05 #501; real HTTP/PostgreSQL lifecycle and browser harness |
| Rejection, withdrawal, suspension browser verification | MERGED | NETWORK-06 #503; lifecycle browser scenarios |
| Feed refresh, retry and latest updates | MERGED | NETWORK-07 #506; current-cursor router refresh and latest link |
| Customer Feed authentication/feature gates | MERGED | NETWORK-08 #509; missing/expired/wrong-role/browser checks |
| Draft/history read recovery | MERGED | NETWORK-09 #511; bounded reads and cursor-preserving retry |
| Approval queue read recovery | MERGED | NETWORK-10 #512; temporary-read errors distinguished from authorization failures |
| Single pin/handoff and audit browser verification | MERGED | NETWORK-11 #513; single-pin service/database checks and real Chromium scenarios |
| Lossless Feed pagination | PARTIALLY IMPLEMENTED on baseline | Existing keyset query truncates PostgreSQL microseconds through JS Date; regression below |
| Business-authored publishing | BLOCKED BY TECHNICAL DEPENDENCY / OWNER DECISION | NETWORK-01 stopped portions; requires eligible BDPN profile contract, business policy/permission approvals |
| Follows, customer posts, post reports, notifications | NOT IMPLEMENTED / BLOCKED BY OWNER DECISION | Proposed NETWORK-00 phases; no approved next implementation dispatch located |
| Environment activation | BLOCKED BY OWNER DECISION | Existing feature gate stays off by default; no rollout authorized |

## Defects reproduced before correction

The real PostgreSQL Network suite passed its 29 existing tests and failed both
new regressions on authoritative main:

1. PostgreSQL `now()` publishes with microseconds. The cursor converted this to
   JavaScript Date milliseconds and rebuilt the SQL boundary from that truncated
   value. Traversal skipped visible posts sharing a millisecond, including exact
   timestamp ties that should use the existing UUID tie-break.
2. The cursor UUID check accepted 36 hyphens. That value reached PostgreSQL UUID
   comparison, raising 22P02 and making the customer read unavailable.

## Requirements and acceptance criteria

- Preserve pinned-first, publication-time-descending, UUID-descending ordering.
- With a stable visible set, traverse every item exactly once, including shared
  millisecond/exact-microsecond timestamps and a pinned first item.
- Carry the database's six fractional timestamp digits through the opaque
  cursor and SQL comparisons without JavaScript Date round-trips.
- Accept previously emitted canonical three-digit millisecond cursors. Such
  old boundaries cannot recover already lost precision; refresh/latest creates
  a new precise cursor. No snapshot semantics for concurrent publication/pin
  changes are introduced.
- Reject malformed UUID/date/envelope inputs before a database query; retain
  the established empty-page outcome for invalid source cursors.
- Keep customer item DTOs, page size/bounds, auth, feature gates, expiry,
  moderation and two-reviewer rules unchanged. No mutations or schema changes.
- Real Chromium traverses 21 posts with a shared precise timestamp at mobile
  375px and desktop 1280px, verifies UUID ordering, latest navigation, keyboard
  focus, 44px pagination control and no horizontal overflow.

## Implementation

The read model selects a private UTC timestamp string for the cursor using
PostgreSQL `to_char(...US...)`, and binds validated strings as timestamptz in
the keyset predicate. The existing customer `publishedAt` rendering is unchanged.
The shared UUID syntax validator and canonical UTC date validation prevent
invalid values reaching SQL. Unit negatives also assert persistence is not called.

The browser test uses existing real JWT/session middleware, current-role queries,
approval service, database triggers and customer Feed page. It creates synthetic
posts through the existing author/two-approver contract. Only their publication
timestamps are shaped directly in the disposable fixture, as existing expiry
tests already do. No approval, pin or authorization rule is bypassed in production.

No frontend production change is needed: the existing next-page/refresh/latest
controls already consume opaque cursors. Their real mobile/desktop behavior is
verified rather than redesigned. Existing refresh-pending, empty, forbidden and error
states remain covered by component and lifecycle tests. No new loading overlay
or navigation route is introduced.

## Security and isolation

Feed reads still require an active authenticated customer, verified phone,
feature flag, customer-keyed limiter and no-store response. The SQL predicate
still requires a published post, approved live revision and unexpired database
time. The source still reads only network posts/revisions; internal cursor data
is not added to customer item fields. Platform admin permissions are revalidated
server-side; business roles, customers, cashier and impersonation cannot moderate.
Existing lifecycle/security suites are rerun; no permission is expanded.

No database schema, journal, historical migration, configuration, infrastructure,
secret or feature-default change. Migration 0085 is merely part of current main;
this branch does not edit it or import proposed 0086 from #539. Local database
execution is confined to disposable loopback fixtures.

## Definition of Done and evidence

The selected block is complete only when the two failing PostgreSQL regressions
pass, existing Community authorization/lifecycle/visibility suites pass, actual
typechecks/lint/unit/build checks pass, new real Chromium mobile/desktop acceptance
passes, and exact-head hosted CI is green with clean mergeability and no unresolved
blocking review threads. Executed counts, skipped tests and local environment
limitations are recorded in the final report and draft PR, not inferred here.

Local Chromium download was attempted but blocked by this runner's network;
hosted Chromium execution must provide browser acceptance, not a mocked substitute.
No merge, deployment, live migration or automatic advancement is authorized.

## Remaining decisions and next recommendation

Business publishing/follows/customer engagement remain governed by the pending
NETWORK-00 decisions, BDPN eligibility and capacity/policy approvals. No change to
the existing two-reviewer or single-pin rules is proposed. For the next block,
first reconcile owner-approved engagement scope; otherwise select only a separately
verified existing-Community defect. Do not infer a NETWORK-13 product specification.
