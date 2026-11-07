# DEV-59 — Closed Notification Event Vocabulary at the Queue Boundary

**Authorization:** Development only. No provider, database or financial writes, no migrations, merge or deployment.

## Baseline finding
The shared-types package defines `notificationEventTypeSchema`, and the application's notification templates only produce supported transactional events. The DEV-46 queue validator nevertheless accepted **any nonblank string** as a notification event type. Invalid enqueued messages could cross the untrusted boundary, reach the notification delivery service, and create attempted notification records for events outside the platform contract.

## Scoped implementation
- Validate queue `send_notification.eventType` using the existing shared `notificationEventTypeSchema` (one source of truth, no duplicate event list).
- Preserve allowed email and SMS channels, message fields, existing queue behavior and all recognized notification events.
- Regression matrix accepts every shared enum option and rejects arbitrary, forged, malformed and non-string event values.
- Existing queue error handling, retry count, dead-letter and bounded metadata remain unchanged.

**Result:** An invalid event is refused by the existing `isPlatformJob` boundary and flows through existing sanitized failure telemetry. CI must verify before owner review.
