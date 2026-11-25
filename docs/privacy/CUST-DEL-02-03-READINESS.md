# Customer deletion — CUST-DEL-02 development and CUST-DEL-03 operator readiness

Status: **DEVELOPMENT BRANCH — NOT DEPLOYED — NOT LEGALLY APPROVED**.
Baseline: CUST-DEL-01 merged as PR #576, `main` `1ef2145ffbd46254e8bacacf9634b1c57e477a79`.

## CUST-DEL-02 — what is implemented

- Settings offers a customer-initiated deletion **request** only on a verified rotating password session.
- A distinct `POST /customer-account/deletion/reauth` checks the current password against that exact live session, records a new step-up and uses the existing 5/15-minute fail-closed customer-auth limiter.
- Filing the request uses CUST-DEL-01's existing idempotent API, revokes all sessions, clears browser credentials and navigates back through login to the pending restoration-only screen.
- The authenticated dashboard detects a pending request before rendering other customer resources; the pending route remains outside the guarded dashboard subtree and permits restoration/sign-out.
- Restoration has an **exclusive** deadline: `now < scheduled_for`. At the exact deadline and afterward, the database repository refuses cancellation. No deletion, anonymization or status advancement occurs automatically.
- Technical interface copy exists for English, French, Spanish and Arabic. These are **not legally approved notices**.
- All web access is dormant unless both `CUSTOMER_EMAIL_AUTH_ENABLED=true` and `CUSTOMER_DELETION_ENABLED=true`; the API requires the same independent gate.

## Deployment prerequisites — intentionally not performed

1. Independent authorization to apply **0088 Community** before **0089 customer deletion** on the staging target, after exact-prefix/database-role/snapshot review. The migration runner cannot be assumed to apply only 0089.
2. Verify CUST-DEL-01 schema, restricted runtime privileges and gate-denial behavior after migration. Prove that the deployed API/web versions are compatible with the upgraded schema.
3. Approve exact customer-facing notices with privacy/legal review (R7), including 30-day dates, what the operator does, preserved ledgers/consent, processors/backups and handling of legal holds.
4. Perform synthetic end-to-end signup/login/step-up/request/logout/relogin/restore/expiry acceptance on staging, with an isolated mailbox and no real customer data.
5. Obtain separate activation approval for `CUSTOMER_DELETION_ENABLED` on **both** API and Web. Never flip one without a tested sequencing/rollback plan. No production deployment is authorized by this document.

## CUST-DEL-03 — operator gate, not silently implemented

CUST-DEL-01 deliberately keeps the `customer_deletion_requests` database guard **cancel-only**. The app runtime must never mutate `privacy_*` tables or execute erasure functions. An eligible request after the 30-day window is **not** automatically erased and remains `pending` until a future separately authorized operator integration reconciles the privacy-request lifecycle.

The existing D2-FINAL engine (0086) has `privacy_requests`, `privacy_request_transitions`, `legal_holds` and operator-only `privacy_request_submit` / `privacy_request_advance` functions. CUST-DEL-03 requires an independent **read-only operator queue**, explicit request-to-engine linkage and protected processing with two-person approval. Before implementation or activation:

- **R5:** designate the privacy operator, a different approving administrator, their access procedure and verifiable reauthentication evidence; the application runtime and migrator are never operators.
- **R1/R2/R6/R7:** approve retention/deletion scope, verified request identity, customer-facing notices, legal holds, processor/backups responsibilities and required evidence.
- Prove no processing before `scheduled_for`, no reprocessing a cancelled request, no duplicate processing, and correct race resolution when a restore collides with eligibility/approval. Preserve append-only audit and loyalty/Community balances.
- Specify a separately reviewed database migration if the guarded request state must transition to `processed`; do not weaken migration 0089's trigger by improvising SQL.
- Test restricted runtime **DENY**, authorized operator **ALLOW**, and independent approver controls using disposable PostgreSQL 16/18. Verify recovery/rollback without altering live data.

A database owner/admin account is **not** a substitute for the missing dedicated privacy operator authorization. No live erasure is allowed.

## Closure verdict rules

- CUST-DEL-02 may be declared **DEVELOPMENT COMPLETE — VERIFIED** only after an exact-head, all-green CI and isolated browser acceptance. CI alone supports implementation regression readiness, not complete end-to-end release acceptance.
- CUST-DEL-03 remains **BLOCKED ON OPERATOR/LEGAL POLICY AND TECHNICAL IMPLEMENTATION**, not a completed feature.
- Overall customer deletion is **NOT PRODUCTION READY** until staged migration, notices, synthetic acceptance, operator governance and separate release approval are complete.
