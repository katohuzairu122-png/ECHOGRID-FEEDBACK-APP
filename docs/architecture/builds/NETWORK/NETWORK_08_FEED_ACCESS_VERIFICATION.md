# NETWORK-08 — Customer Feed access and feature-gate browser verification

## Baseline and scope

Authoritative main `72cc87711a5f15970047f45ba649915a49b0fd8b` contains
NETWORK-07 PR #506. Existing API/unit tests cover customer identity and Feed
gates; the previous real browser suite covered publishing and pagination but
not browser denial/revalidation or Points & Membership with the Feed disabled.

This block adds verification of existing contracts. It introduces no product
policy, permission, customer identity change, endpoint, schema or production UI.
BDPN PR #507 is a separate workstream and shares none of these changed files.

## Added real browser scenarios

1. A published positive control remains inaccessible with only staff cookies,
   malformed/expired customer credentials, or staff/cashier/impersonation tokens
   placed in the customer cookie. The API returns 401, the browser goes to
   customer sign-in, and post content is absent. A valid customer then reads it.
2. The same valid customer token loses Feed access when persisted phone
   verification is removed (403 and a forbidden UI), and when customer status
   becomes suspended (401 and sign-in). Refresh revalidates current persistence.
   Synthetic eligibility changes are restored in a finally block.
3. False, uppercase and empty Feed flag values fail closed. Direct Feed access
   is unavailable, the internal Feed navigation disappears, and real customer
   Points & Membership reads remain available. Membership/account/transaction
   row counts are unchanged. Feed/status success responses are private/no-store.

## Infrastructure and boundaries

Reuse the existing disposable PostgreSQL and actual Chromium/Next production
build/API harness. Mount existing Community read routes in that test app to
verify the hub against real persistence. A per-browser-test flag callback changes
only the synthetic Hono bindings. Production flags and identity contracts are
untouched. Existing lifecycle/approval tests continue running in the same suite.

No deployment, live database operation, migration change, secret change, financial
activation, Business Follow, engagement, PLATFORM-IDENTITY-01 or BDPN D-18.
Execution counts and exact-head hosted CI are recorded in the draft PR.
