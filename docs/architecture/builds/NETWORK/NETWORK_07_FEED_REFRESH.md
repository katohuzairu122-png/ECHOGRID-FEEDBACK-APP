# NETWORK-07 — Customer Feed refresh and pagination

## Reconciliation

Base main `4fd02f87048997874b4d5edd7e6d04cc66560d4d` includes merged
NETWORK-06 PR #503. Existing customer Feed reads are paginated, customer-authorized,
feature-gated and uncached. The UI offered forward pagination but no return to
latest updates, and its error retry linked to the current URL.

## Scope

Add explicit current-page refresh and a latest-updates link on cursor pages,
including empty and unavailable pages. Refresh uses Next.js router refresh so
the current route and cursor are preserved and the existing server read contract
runs again. Pending refresh disables the button and exposes busy state. All four
supported locales receive labels. Forbidden results offer neither control.

No API contract, permissions, publication lifecycle, feature defaults, identity,
ledger, B2B or persistence changes. Existing moderation controls still determine
which posts the customer Feed may return. This block introduces no engagement
or follow functionality.

## Verification

Component tests cover refresh, retry, empty-page recovery, forbidden results,
cursor links and existing safe rendering. Existing API regressions retain
approval, role, draft and audit coverage. Two additional real Chromium scenarios
in the disposable PostgreSQL lifecycle workflow exercise refresh after publication
and withdrawal, and a 21-post pagination traversal with return to latest.

The dedicated workflow now also watches customer Community UI and loyalty locale
changes. Its database is a synthetic disposable CI service initialized with
existing migrations, never a staging or production database. Exact-head CI and
local execution results are recorded on the draft PR.
