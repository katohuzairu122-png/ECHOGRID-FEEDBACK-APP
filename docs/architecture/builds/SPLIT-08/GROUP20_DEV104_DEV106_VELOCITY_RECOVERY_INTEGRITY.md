# Group 20 DEV-104–106 — Anti-abuse KV recovery integrity

**Status: DEVELOPMENT ONLY. Unmerged and unverified for production.**

## Verified problem
The KV-backed velocity counter previously used JSON.parse and then trusted stored fields as CounterState. A parse exception or corrupted count could break the reward/feedback request without a stable failure reason; malformed state could also reset the velocity counter instead of producing a defensible security failure.

## Blocks
- **DEV-104 — Configuration preflight.** Validate bounded integer rate-limit window/threshold, event key, subject and hashed salt before KV operations. Misconfigured abuse controls fail closed.
- **DEV-105 — Durable evidence integrity.** Reject malformed, replayed-from-future, overflowing and otherwise impossible KV counter states; never reset/overwrite them and never report a clean anti-abuse check. Return a stable internal `VELOCITY_STATE_UNAVAILABLE` error without raw IP, raw device signals, salts or KV contents in the error text.
- **DEV-106 — Cooldown integrity and recovery regression.** Reject malformed TTL and unexpected stored cooldown values without write-through. Preserve healthy cooldown expiration behavior and the existing device/IP threshold policies. Unit tests use injected KV only.

## Architecture boundaries
The existing native Cloudflare rate limiter remains the hard upstream rate ceiling. KV velocity remains eventually consistent and is not a new transactional authorization primitive. PostgreSQL is authoritative for actual point/reward movement. No reward rules, monetary economics, provider operation, API schema, Stripe interface, migration, RLS or production configuration changed.

## Review requirements
1. Exact-head CI, API unit/integration and security verification must pass.
2. Confirm error middleware returns generic failure without leaking metadata; inspect observability and ensure current production alerting catches failures.
3. Independently inspect Cloudflare KV input/TTL runtime compatibility.
4. Reconcile with current main if other groups merge.
5. Explicit owner approval required before merge or deployment.
