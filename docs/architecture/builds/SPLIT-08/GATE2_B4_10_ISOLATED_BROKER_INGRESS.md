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
