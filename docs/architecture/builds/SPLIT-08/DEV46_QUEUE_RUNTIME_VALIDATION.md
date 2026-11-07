# DEV-46 — Runtime Queue Payload Validation

**Scope:** development-only fail-closed validation at the active Cloudflare `JOBS` queue consumer before any job-specific domain service is called. No new job types, migrations, provider operations or deployment.

## Implementation
- `apps/api/src/queue/platform-job-validation.ts` implements a pure discriminated validator for `classify_feedback`, `generate_summary`, `send_notification`, and `escalate_critical_incident`.
- `apps/api/src/index.ts` rejects unrecognized/malformed queue payloads with `QUEUE_JOB_PAYLOAD_INVALID` inside the existing catch/retry path; no invalid message reaches normal `message.ack()`.
- Existing retry backoff, dead-letter routing, success acknowledgements and domain-service idempotency are preserved.
- `apps/api/src/queue/platform-job-validation.test.ts` adds valid and invalid payload tests.

## Known limitations / review gates
- The validator enforces basic shape, nonempty identifiers, supported channels and parseable summary dates. It does **not** prove tenant ownership, sender trust, event-type membership, notification address correctness or external provider idempotency. These remain domain/service and integration test obligations.
- Invalid jobs will retry according to existing queue policy and ultimately enter the DLQ; there is no direct quarantine route. Verify the configured max retries and DLQ observability before staging.
- The existing DLQ handler accesses `message.body.type` and logs `body`; malformed non-object messages may cause alerting failure. This is a **separate unresolved defect** to address before staging. Do not treat this PR as complete malformed-payload safety across DLQ.
- Existing `send_notification` contract admits `push` as a forward-compatible type, but current delivery implements only email/SMS. The validator intentionally rejects `push` until an implementation is reviewed.
- Tests are authored but not executed by this GitHub-only editing session. Exact-head CI, typecheck, and integration behavior require independent verification.

## Verdict
**IMPLEMENTED — INDEPENDENT TEST/REVIEW REQUIRED.** No automatic merge, migrations, staging, production or financial execution.
