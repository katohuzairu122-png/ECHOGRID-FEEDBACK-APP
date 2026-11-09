# Gate 2 B4-10 — Isolated Broker Ingress (Unmounted)

**2026-11-09 — DEVELOPMENT ONLY. No deployment or credentials.**

Baseline authoritative main: `81cbc01dbb247eece71648be63a3abb38924abf1`, includes merged PR #333. Hosted R15 CI and integrated R15 mandatory CI on #333 passed. B4-09 is merged.

This block adds `apps/api/src/auth/broker-isolated-ingress.ts`, a narrowly bounded pure Request preflight intended for a *future* isolated broker worker. It does not export or mount any fetch handler, route, SQL client, secret or service binding.

Behavior:
- Accept only POST `/internal/broker/v1/branch-read`, exact JSON media type, no query string.
- Bound the actual request bytes at 8 KiB, even when Content-Length is absent or inaccurate; reject malformed UTF-8/JSON.
- Verify the two independent B4-03 and B4-09 signatures using trusted key-source dependencies supplied by a future independently certified composition root.
- Return `acceptedForEvaluation: true` only for cryptographically valid provenance, with `brokerAuthorization: NOT_GRANTED` and `deploymentAuthorized: false` **unconditionally**.
- Never execute SQL, authorize a financial request, consume a nonce, or perform runtime cutover.

Unit tests exercise valid signed evidence (provenance only), wrong method, path, query, media type, >8 KiB body, forged fields and tampered assertion. This stage does **not** establish an authenticated Cloudflare service binding: a compromised caller with a signing key could produce otherwise valid evidence.

Required independent follow-up:
1. Protected service-to-service authentication and independently protected workload key custody; key rotation and revocation.
2. Real isolated broker service Worker, with no public exposure and a strict source/workload identity boundary.
3. Atomic nonce replay, exact-session/use-time authorization and coordinated revocation.
4. Restricted nonowner PostgreSQL login and sole fixed broker operation, adversarial tenant SQL denial tests, isolated staging smoke.
5. Signed release approval and staged credential rollout. **Production Hyperdrive remains owner/BYPASSRLS; do not cut over prematurely.**

**Verdict:** An isolated transport preflight is implemented but **not a deployable broker or production release authorization**.

## Corrective review — bounded asynchronous work

Based on PR #334 head `bbaebfd5b8673e73ab66150a5be84babd3b3c2e8` without modifying that branch. Two adversarial tests reproduced indefinite waits: a body stream that never yields, and an oversized body whose cancellation never settles.

The preflight now applies a five-second deadline across stream reading and trusted key lookup, caps chunk count at 8,192 (including empty chunks), and owns copies of streamed bytes. Cancellation rejection is observed but cancellation is never awaited. Timeout is a deterministic non-authorizing `INGRESS_TIMEOUT` result. Timers and reader locks are released on completion. A dependency's underlying I/O is not forcibly terminated; future production key providers must implement their own transport cancellation and resource limits. No late result can trigger SQL or authorization in this preflight.

The final parameter is now a trusted `() => number` clock returning epoch seconds, rather than a timestamp captured before asynchronous work. Expiry of both signed envelopes and resolved key windows is rechecked at acceptance; backwards or invalid time fails closed. The existing canonical signature formats and unconditional NOT_GRANTED result remain unchanged.

New adversarial coverage includes stalled reads, hanging/rejecting cancellation, unlimited empty chunks, stalled key resolution, evidence expiry during key lookup, backwards clock movement and malformed UTF-8 before key lookup. This correction does not certify live workload identity, nonce consumption, restricted SQL or production deployment. PR #334 and this corrective branch require owner-controlled integration; neither is merged automatically.
