# DEV-47 — Queue Failure Observability Hardening

**Development-only.** This block builds on DEV-46's queue payload validator and DLQ metadata minimization.

## Scope
- Replace the normal queue consumer's raw `err.message` logging and untrusted `message.body.type` with bounded, allowlisted metadata.
- Preserve `message.retry`, backoff, success `ack`, DLQ handling, and all domain-service calls.
- Add pure Vitest cases for malformed input, sensitive provider errors and invalid attempt counts.

## Security properties and limits
- The `errorCode` is one of `QUEUE_JOB_PAYLOAD_INVALID` or `QUEUE_JOB_PROCESSING_FAILED`; arbitrary provider exception strings never appear in this structured log.
- `jobType` uses DEV-46's bounded type sanitizer. `payloadValid` indicates only type-token shape, **not** full job schema validity.
- Existing `messageId` remains for correlation and is not interpreted as authorization.
- This does not add a metrics backend, alert deduplication, tenant checks, or guarantee successful DLQ notifications.
- CI and test execution are unverified; PR remains draft until independently reviewed.

## Dependency
DEV-47 is **stacked on DEV-46 PR #270**. Review and merge DEV-46 first; rebase DEV-47 onto authoritative main before its final review. No auto-merge, deployment, migrations or external provider calls.
