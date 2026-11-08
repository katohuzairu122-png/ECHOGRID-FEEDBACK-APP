# Group 19 — DEV-101–103 Customer Messaging History Integration

Status: **DEVELOPMENT ONLY — UNMERGED; NOT PRODUCTION CERTIFIED**

## Verified gap
The authenticated customer conversations list and customer thread message list returned unrestricted collections, although survey and consent histories already enforce bounded pagination. This creates unbounded reads as businesses and messages accumulate.

## Changes
- **DEV-101** — Customer conversations GET `/api/v1/messaging/me/conversations`: canonical `limit` (1–100; default 100), `offset` (0–1,000,000; default 0) parsed before a history query. Repository now uses deterministic `last_message_at DESC, id DESC` ordering and SQL limit/offset. Still always scoped by authenticated customer ID; no tenant mixing.
- **DEV-102** — Customer message history GET `/api/v1/messaging/me/conversations/:businessId/messages`: same paging contract. Authorization still first resolves the conversation for the authenticated customer and supplied business; only its messages are queried. Message ordering is deterministic `created_at DESC, id DESC`. Staff message route behavior remains unchanged.
- **DEV-103** — Mounted-route regression coverage for customer JWT, default 100/0, explicit 25/50, malformed query rejection, and identity-scoped service arguments.

## Compatibility and unresolved integration
The API response wrapper remains `{success:true,data:[...]}`, but default listings are now a page (100 items) rather than all history. The customer thread page now provides Older/Newer message page navigation using the bounded API. Other API consumers must request subsequent pages explicitly. Existing translations for the new navigation labels and deep-link pagination handling require UI review before owner approval.

No new feedback-to-loyalty bridge, reward issuance, consent grant, survey completion economic effect, push notification behavior, staff authorization, Stripe operation, RLS or migration is introduced.

## Review gates
1. Exact-head hosted CI and integration tests PASS.
2. Inspect and update customer web consumers as required for paginated history.
3. Verify replay/cross-customer/foreign-business denial via existing security suite.
4. Reconcile with latest authoritative main if concurrent groups merge.
5. Owner approval before merge; deployment not authorized.
