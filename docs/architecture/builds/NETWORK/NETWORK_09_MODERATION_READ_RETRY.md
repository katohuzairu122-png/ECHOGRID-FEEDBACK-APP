# NETWORK-09 — Moderation read-error recovery

## Reconciliation

Base main `e620dec48a47a7db8f7386dfe7906be44a37572d` contains merged
NETWORK-08 PR #509. History and saved-draft pages already enforce platform
permission checks and uncached API reads. Their error recovery links restart
pagination; no control retries a temporary read at the current cursor/selection.
Claude's active BDPN work has no shared files with this block.

## Behavior

A shared client button refreshes the current server-rendered route on demand,
preserving query parameters. It is disabled and busy during the transition and
uses the existing Button component. History, draft-list and selected-draft
failures offer it only for upstream 5xx or non-API read exceptions, after Next.js
control-flow exceptions have been rethrown. No automatic retry loop is added.

Existing denied/disabled responses still produce not-found behavior. Missing
selected drafts, invalid input and 429 responses keep their existing recovery
paths. Generic UI errors never include raw exception details. Existing links to
the latest/first page remain available. Successful editor views gain no refresh
control, avoiding any new interaction with unsaved editing state.

## Verification

Component tests cover temporary failures, preserved cursor reads, safe errors,
no mutation invocation, missing/invalid/rate-limited selection, denial and
redirect control flow. Real Chromium scenarios inject synthetic GET-only
upstream failures in the existing disposable harness, then exercise actual Next
server reads against real API authorization and PostgreSQL. They check history
cursor preservation, denial after role revocation, draft-list and selected-draft
recovery, unchanged draft state/author/revision/audit counts and GET-only reads.

## Restrictions

No API, permission, audit contract, lifecycle, feature flag, identity, ledger,
B2B, schema/migration or secret change. No deployment, live database operation,
automatic merge or activation is authorized. No PLATFORM-IDENTITY-01, financial
activation, BDPN D-18, Business Follow or customer engagement work. Exact-head
CI results and executed-versus-unexecuted checks are recorded on the draft PR.
