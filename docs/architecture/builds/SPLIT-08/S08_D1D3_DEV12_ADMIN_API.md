# S08 D1/D3-DEV-12 — Secure Administrator API and Authorization Policy Control

Status: DEVELOPMENT ONLY. Inert. Financial activation: NO-GO. **No migration** (reuses 0062 / 0063). No Stripe contact, no secrets or signing keys reachable, no ledger access. Predecessors #230, #232, #233 are merged (main 12e9502 at authoring).

## Routes (`apps/api/src/internal/stripe-read-admin.routes.ts`, mounted at `/api/v1/internal/stripe-read`)
| Route | Purpose |
|---|---|
| `GET /policy` | READ-ONLY approval-policy status (`ENABLED` / `DISABLED` / `UNKNOWN`; unknown is treated as disabled). There is no write handler anywhere in the module. |
| `POST /authorizations` | Propose (PENDING). Refused unless the policy is enabled. |
| `POST /authorizations/:id/approve` | Approve (distinct administrator; refused unless the policy is enabled). |
| `POST /authorizations/:id/revoke` | Revoke (terminal, idempotent). |
| `GET /authorizations/:id?businessId=` | Status (scope mandatory; a foreign scope looks like a missing id). |
| `GET /authorizations/:id/audit?businessId=&limit=&afterVersion=` | Audit history, ordered by version, `limit` 1..100, opaque administrator references. |

## Independent controls (`/internal` is not the boundary)
1. Deployment: 404 unless `INTERNAL_STRIPE_READ_ADMIN_API = 'enabled'`. 2. Gateway token (>= 32 chars, constant-time) or 404. 3. Any `Origin` header is refused (server-to-server; bearer tokens only, so CSRF does not apply; no CORS grant). 4. Strict rate limiter, JSON-only, 4 KiB body limit. 5. Session-bound administrator authentication (DEV-11-R1) creating the only `TrustedAdminContext`; the administrator is never read from a body, header or query; every privileged service call re-verifies the exact persisted session. 6. The database (DEV-10) still enforces administrator status, distinct proposer/approver, terminal revocation, expiry, row locks and audit.
All responses are `Cache-Control: no-store`, errors name no token, session id or submitted value, authentication denials are logged with a reason and correlation id only.

## Proposal validation
Strict schema (mass assignment rejected). Only the two performable read methods are accepted (the other four registry names, write-shaped names and everything else: 422). Realm must be `test`. The business must exist and be active. The workload reference (id, account, realm, method) must equal the TRUSTED verifier workload configuration; none provisioned means 409 `WORKLOAD_NOT_PROVISIONED` (the default). The inventory record id is fixed by the server.

## Known limits
1. The deployment has no trusted workload configuration source yet (`workloadConfig` defaults to null), so proposals fail closed until the owner provisions one; the application database role must hold the DEV-10 admin and auditor roles (provisioning is an owner decision).
2. Policy-change audit: the policy has no write path in the API. A durable policy-change audit trail would need a new table and trigger; not added here (no migration); the owner-controlled activation process must provide it.
3. The 6-per-tuple audit sort in the handler is redundant with the SQL ordering (equivalent mutant).
4. The `AUTH_RATE_LIMITER` binding is reused (no new binding).
