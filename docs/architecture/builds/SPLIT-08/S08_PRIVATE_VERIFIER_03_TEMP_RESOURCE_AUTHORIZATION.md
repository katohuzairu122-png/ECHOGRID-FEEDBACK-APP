# S08-PRIVATE-VERIFIER-03 — Conditional authorization for temporary resource-only test

**Owner approval:** 2026-11-03. **Purpose:** isolated test-only provisioning and identity verification. **Status:** AUTHORIZED FOR RESOURCE-ONLY CREATION; NOT YET EXECUTED.

**Owner constraint:** "if its temporary for testing only proceed".

- **Authorized Cloudflare account:** INFINICUS LLC `b0ca727d821092e2e14720223ac07edb`.
- **Exact resource name:** `echo-grid-s08-stripe-test-verifier`.
- **Operator must first verify:** exact account OAuth and Worker absence via complete inventory and exact-name lookup immediately before creation. A failed inventory is NOT proof of absence. Stop on collision.
- **Authorized action:** Create only an unversioned standalone Worker resource via Cloudflare's documented resource-only API *if supported by this account*. No code or deployment upload, no secret, public hostname, route, custom domain, schedule, queue, trigger, service binding or Stripe API call.
- **Post-create verification:** independently GET resource by name; record immutable UUID, account, version/deployment count (expected zero), public ingress settings and absence of invocation routes/triggers. Stop/report if any unexpected execution surface appears; no corrective destructive changes without owner consent.
- **Existing ECHO GRID services:** Four production/staging Workers in personal account `cf205213947e3617297373060fe4c15f` remain untouched, including domains, routes, schedules, KV, R2, Hyperdrive and queues. ECHO GRID remains independently operated; INFINICUS LLC is the designated infrastructure host only.
- **Ephemeral lifecycle:** Resource is temporary and exclusively for testing. Record its creation timestamp, operator and teardown owner. Do not leave it indefinitely; at end of the authorized test, request owner-approved resource deletion after independently confirming there are no dependent assets or runtime uses. Creation permission does not authorize deletion.
- **Separate authorization required:** Any executable deployment, key issuance, encrypted secret provisioning, Stripe read, financial operation, public endpoint, migration, or automated merge.

## Evidence fields — must be populated from authenticated Cloudflare responses

| Field | State |
|---|---|
| Latest complete worker list / exact-name absence recheck | PENDING |
| Resource-only API support and creation status | PENDING |
| Created Worker resource UUID | PENDING |
| Actual versions/deployments = 0 | PENDING |
| Public workers.dev / preview hostname and other ingress | PENDING |
| Route/domain/trigger/service-binding audit | PENDING |
| Creation operator and timestamp | PENDING |
| Test completion and owner-approved cleanup | PENDING |

**Current verdict:** GO for conditional resource-only creation through the authorized Cloudflare session; **NO-GO** for claims of successful provisioning until verified API evidence is returned. No infrastructure mutation is performed by committing this record.
