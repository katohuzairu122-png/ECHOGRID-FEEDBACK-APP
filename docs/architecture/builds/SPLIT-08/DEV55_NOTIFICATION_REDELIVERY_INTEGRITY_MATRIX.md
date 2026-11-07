# DEV-55 — Notification Delivery/Redelivery Integrity Evidence

**Scope:** Development-only regression tests of current nonfinancial notification dispatch; no runtime delivery changes.

## Evidence targets
New `notification-delivery.service.test.ts` verifies:
1. Pending notification records precede email/SMS provider sends.
2. Successful providers are followed by `markSent`.
3. Provider failure is followed by `markFailed` and the queue-facing error propagates.
4. A database failure before pending insertion cannot invoke the provider.
5. A successful provider send followed by a failed status update is an **ambiguous outcome**, not proof delivery failed.
6. The existing at-least-once queue semantics permit a redelivered job to send again and create another log row.

## Unresolved architecture gate
Notification jobs currently carry no stable dispatch idempotency key and the notification log is not used as a transactional provider dedupe boundary. Exactly-once external delivery **is not established**. Do not add automatic replay, extra provider calls, debit/credit changes, or claim deduplication. A later approved design should decide persisted dedupe identifiers, outcome uncertainty handling and provider-specific idempotency capabilities before changing sends or retry policy.

This test block neither invokes external providers nor changes financial settlement/loyalty accounting, data schemas, migrations or production resources.

**Verification:** Verify tests and full exact-head CI before owner review.
