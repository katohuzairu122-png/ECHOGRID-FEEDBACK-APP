# Proposed S08 test-mode point evidence profile

Proposed November 3, 2026, for owner and architecture review. This narrows the [method-profile acceptance review](S08_METHOD_PROFILE_ACCEPTANCE_REVIEW.md) to a single directly authenticated Stripe test account and a private billing verifier. Account and credential inventory identifiers are pending. This proposal supplies no operational authority.

| Decision | Recommended scope |
| --- | --- |
| Producer | Dedicated private billing verifier with an authenticated workload identity and independently approved credential inventory. Use a restricted test credential with only the account and invoice read permissions required for qualification. Record its inventory revision. |
| Account and mode | One explicitly inventoried account and test realm. Compare the credential principal from GET /v1/account against that inventory, then require livemode=false on the invoice. Deny missing or conflicting scope, connected-account requests and caller-selected account overrides. |
| Invoice method | GET /v1/invoices/{id} with Stripe-Version 2026-05-27.dahlia. Resolve the exact invoice and its business, customer and subscription expectations from trusted local evidence. Compare returned identity, parent, status, currency and amounts. |
| Evidence | Capture request ID, request and receipt times, source version, exact scope, redacted manifest and current binding, configuration, credential and incident revisions. Preserve evidence as an immutable point observation. |
| Reliance | Zero beyond observation. Clock-skew allowance remains unset. Recheck local permission and revisions at each evaluation. Missing, expired, conflicting or revoked evidence denies reliance. |

## Qualification plan

1. Confirm the private workload identity, expected account ID, test realm and restricted credential version through the approved inventory. Verify that account and invoice reads are permitted within that exact scope. Any execution requires separate approval of that inventory and private read path.
2. Use synthetic evidence to check wrong account, live-mode response, unsupported parent, wrong tenant, missing provenance and revision changes. A fixture can verify the denial logic. Provider behavior needs separately authorized read-only evidence.
3. Report exact methods, redacted request references and matching fields. Keep the point-observation decision separate from provider operation admission. A successful read gives zero validity for mutable invoice state through a later commit.

The owner decision requested is approval of this narrow method and a reference to the exact test account and verifier inventory. Keep allocation authority flags false and retain the existing guards. The [pinned invoice reference](https://docs.stripe.com/api/invoices/retrieve?api-version=2026-05-27.dahlia) and [account retrieval reference](https://docs.stripe.com/api/accounts/retrieve?api-version=2026-05-27.dahlia) are the source references for the proposed reads.
