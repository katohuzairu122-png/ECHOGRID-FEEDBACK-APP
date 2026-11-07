# DEV-48 — Dead-Letter Queue Metadata Validation

**Scope:** Development-only correction to DLQ operational metadata. No queue, retry, acknowledgment, provider, financial or deployment changes.

## Baseline defect
`describeDeadLetterPayload` accepted any lower-case identifier matching a regex as a job type and set `payloadValid: true` without validating the queue contract. The main-queue DEV-47 failure metadata already used an explicit type allowlist and full DEV-46 validation. A dead-letter alert could therefore disclose an arbitrary type string and incorrectly label malformed messages as valid.

## Change
- Only `classify_feedback`, `generate_summary`, `send_notification`, `escalate_critical_incident` or `unknown` can be reported.
- Validity is determined by the existing `isPlatformJob` validator.
- The alert never copies arbitrary message body fields, recipient data or customer text.
- Recognized discriminants with incomplete or disallowed fields remain recognizable but `payloadValid` is false.

## Evidence to collect
The updated unit suite covers malformed primitives, unknown strings, all four valid shapes, malformed known types and private-field exclusion. Confirm exact-head CI and TypeScript checks before marking verified.

## Boundary
The DLQ continues to acknowledge messages after a best-effort `notifyOps` call. This block does not claim durable remote alert delivery or automatic replay. No migration, deployment or financial capability.
