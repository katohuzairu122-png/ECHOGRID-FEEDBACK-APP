# P1: business Partner Program terms (read-only)

Status: IMPLEMENTED, validation pending (draft PR; nothing deployed).

## Scope
A read-only business screen on the ONE existing business-facing endpoint, `GET /partner-credits/consent/terms`
(business-wide `billing:manage`). No API, DB, auth or migration change.
- Page: `/dashboard/billing/partner-terms`, linked from a "Partner Program" card on the Billing page.
- Shows the policy version, the terms text and the SHA-256 digest exactly as served.
- **No accept or enroll control.** `POST /partner-credits/consent/accept` is not called anywhere. Acceptance and
  enrollment stay separate, explicitly authorized actions, and financial activation remains NO-GO.
- 401 goes to login; 403 is an explicit denial (no retry, no terms); any other failure is an explicit
  "could not be loaded" state with retry. A failure is never shown as empty terms.

## Not delivered (needs a backend decision)
- **Enrollment status.** There is no business-facing read endpoint for enrollment or acceptance state (the
  enrollment service is admin-recorded and has no GET). The page says so plainly instead of guessing. Showing
  status needs a new authorized read endpoint.
- Partner Credit balances or ledger: no business-facing endpoint exists.
