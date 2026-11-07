# DEV-67 — Enrolled-Customer Authorization Before Conversation Creation

**Authorization:** Development only. Business-scoped messaging eligibility invariant.

## Verified baseline gap
`conversations.ts` and the staff messaging route already specify that staff can initiate conversations only with loyalty-enrolled customers in the same business. `ConversationService.getOrCreateForCustomer` nevertheless accepted any global customer ID and created/reused a business conversation without checking that the scoped loyalty account exists.

## Implementation
- Inside the existing transaction, require an active (nondeleted) `loyaltyAccounts.findByCustomerAndBusiness(customerId, businessId)` record before existing-conversation lookup or creation.
- Return HTTP 404 `CUSTOMER_NOT_ENROLLED` for nonenrolled customer/business pairs, without reading or creating the conversation.
- Preserve existing idempotent conversation reuse and business/customer-specific creation behavior for enrolled customers.
- Add DB-mocked service tests for denied foreign or absent membership, successful creation, existing conversation reuse, removed enrollment and membership lookup failure.

## Explicit limitations
Only *conversation initialization/reuse in the staff create route* is gated here; no blanket revocation of previously created conversations or change to messaging read/send routes is authorized. The existing transaction and uniqueness model remains unchanged. This check uses the existing scoped repository query; it does not grant any cross-business access, financial/loyalty points, or customer data exports.

**Verification:** Exact-head CI, architecture review and separate owner merge approval; no automatic merge or deployment.
