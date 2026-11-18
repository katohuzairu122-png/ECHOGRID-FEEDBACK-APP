# NETWORK-11 — Official-post pin and unpin verification

## Reconciliation

Authoritative main `2a40dc497b36df2c566a60e0d0e07d923aeb956a` contains merged
NETWORK-10 PR #512. There are no open PRs at reconciliation. The existing
NETWORK-01 contract already permits platform moderators to pin a visible official
post, replacing any previous official pin, and unpin posts. It specifies one
platform-wide official pin, customer Feed pinned-first ordering, and existing
publication expiry from the database clock. No policy is added by this block.

Real PostgreSQL tests cover this service behavior, but the actual moderation
forms, customer Feed ordering and pin/unpin audit presentation have no dedicated
browser scenario. NETWORK-11 closes that gap without duplicating the service
implementation or adding permissions.

## Added verification

- Confirmed pin and unpin Server Actions route to the existing API; unconfirmed
  requests never call it. Changing action or post handle clears UI confirmation.
- Real Chromium pins an older published post, verifies customer-visible ordering,
  unpins it and verifies chronological ordering, then transfers the single pin.
  History shows the existing explicit pin/unpin audit events and both live
  revisions retain their two approvals. The existing contract does not require
  inventing another audit event for the implicit handoff.
- Browser pin attempts on unpublished, expired, suspended and withdrawn posts
  are refused with no state or pin-audit change and no customer Feed visibility.
- A previously authorized moderator is revoked before submitting the visible
  pin form. Server Action and real API checks deny it. Cashier, customer and
  impersonated credentials cannot pin or unpin. Synthetic role changes are
  restored in finally.

Expiry setup uses only disposable synthetic rows and the same timestamp update
already used in the PostgreSQL expiry suite. It does not change any expiry,
retention or publishing contract. Existing real JWT, role queries, API routes,
transactions, triggers and audit middleware remain in the browser harness.

## Boundaries and evidence

Only tests and this record change. No production code, B2B, identity, permission,
API, moderation lifecycle, ledger, schema/migration, secret or feature flag change.
No deployment, live database operation, automatic merge, financial activation,
PLATFORM-IDENTITY-01, BDPN D-18, Business Follow or customer engagement work.
Executed local and exact-head hosted results are recorded in the draft PR;
PostgreSQL and Chromium execution use disposable hosted infrastructure.
