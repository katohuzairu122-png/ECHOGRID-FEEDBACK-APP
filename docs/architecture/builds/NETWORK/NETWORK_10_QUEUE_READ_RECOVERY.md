# NETWORK-10 — Pending-approval queue read recovery

## Reconciliation and dependency

Authoritative main at start: `e620dec48a47a7db8f7386dfe7906be44a37572d`.
NETWORK-09 PR #511 remains unmerged at implementation time, with tested head
`783d7c28e859cb6b05419bc7e89c8762a8f7ad5d`. This separate development branch
inherits those original commits to reuse its read-failure classifier, retry
button and disposable GET-outage harness. It does not recreate or modify the
NETWORK-09 branch. The draft PR targets main so existing exact-head CI runs;
its diff includes NETWORK-09 until #511 merges. Review NETWORK-10's own commit
separately and merge #511 first. No automatic merge is authorized.

Claude's active BDPN transition-service work is outside this block and shares
none of its changed files.

## Existing gap and correction

The queue page throws temporary read errors to the whole-page boundary, removing
access to the otherwise independent history and saved-draft views. It now renders
a safe queue-unavailable state and reuses NETWORK-09's current-route retry for
5xx/network read errors. History and saved-draft links remain available.

An unavailable queue is never represented as empty. Review and authoring forms
are rendered only after a successful queue read. A genuine empty response retains
the existing workspace and authoring behavior. Authorization and disabled-feature
401/403/404 denials remain not-found responses; redirects remain control flow;
400/429 and other non-temporary errors retain the existing boundary. Error details
never appear in the recovery UI. No automatic retry loop or policy is introduced.

## Verification

Component tests cover outages, safe copy, no false empty state or mutation
controls, independent links, retry, denial, redirects, rate limits and genuine
empty queues. A real Chromium/Next/API/PostgreSQL scenario injects a synthetic
queue GET outage, uses both independent views, recovers the pending revision,
then proves revoked-role and flag-off denial. Browser API requests remain GET-only
and the post author/state, revision body/status, approval count and audit count
remain unchanged. Existing independent-approval and lifecycle regressions remain.

## Boundaries

No API/permission, identity, publication lifecycle, audit, B2B, ledger, feature
default, migration/schema or secret changes. No deployment, live database operation,
financial activation, PLATFORM-IDENTITY-01, BDPN D-18, Business Follow or customer
engagement. Exact local and hosted execution counts belong to the draft PR.
