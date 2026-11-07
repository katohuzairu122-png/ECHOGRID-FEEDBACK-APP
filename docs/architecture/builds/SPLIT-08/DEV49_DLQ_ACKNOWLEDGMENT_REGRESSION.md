# DEV-49 — Dead-Letter Queue Acknowledgment Regression Boundary

**Scope:** Isolate the existing DLQ handler for direct behavioral tests, without changing its runtime semantics or authorization.

## Implementation
- The DLQ handler is moved unchanged in behavior from `apps/api/src/index.ts` to `apps/api/src/queue/dead-letter-consumer.ts`.
- The Worker entrypoint still routes by the exact configured DLQ name **before** connecting to Hyperdrive.
- Each DLQ message receives one bounded alert and is acknowledged individually after the alert helper resolves.
- `notifyOps` logs locally and treats webhook delivery as best-effort; its documented failure-swallowing behavior remains unchanged.
- No automatic replay, database persistence, retry-policy, acknowledgment timing, provider or financial operations are introduced.

## Tests and review gates
- Mixed valid/invalid job batches produce separate bounded alerts and individual acks.
- Alerts contain no arbitrary job payload fields.
- Acks occur only after the alert helper resolves.
- An unexpected internal alert-helper rejection must not acknowledge the affected message.
- No DLQ message is explicitly retried by this handler.
- Verify TypeScript, unit tests, build and exact-head hosted CI. Queue-runtime behavior remains a staging/production verification gate, not asserted by these unit tests.

## Limitations
Once an alert is logged, a webhook delivery error is still nonfatal and the DLQ message is acknowledged; this is the existing intentional discard tradeoff. Durable out-of-band alert receipts or automatic replay require a separate architecture decision. No deployment or production certification.
