# DEV-62 — Notification Enqueue Failure Log Redaction

**Authorization:** Development only. No deployment, migration, financial or external-provider actions.

## Verified defect
`NotificationService.notify()` catches queue submission failures and deliberately continues to the next notification channel. Its existing console diagnostic copied `err.message` or a thrown arbitrary object into Workers Logs. Queue/provider errors can contain customer addresses, rendered feedback, tokens or provider URLs.

## Scoped remedy
- Retain per-channel best-effort enqueue, caller isolation, business ID/event/channel context and the existing fixed diagnostic heading.
- Replace arbitrary exception content with fixed `NOTIFICATION_ENQUEUE_FAILED` error code.
- Tests inject both Error and non-Error sensitive payloads and prove no private exception data or recipient address appears in logs.
- Preserve existing failure swallowing and attempt counts. No new provider behavior or retry policy.

## Limitations
A best-effort enqueue failure can still cause a missing notification, as before. The event metadata identifies the affected channel, not the detailed provider failure cause.

**Gate:** Exact-head GitHub CI and independent review required before merge.
