# CASHIER-PROD-D2-R8: audit integrity foundation and identity-linkage design (2026-11-19)

Status: **IMMUTABILITY FOUNDATION IMPLEMENTED (migration 0085, tested on disposable PostgreSQL, NOT applied to any shared database). IDENTITY MINIMIZATION NOT IMPLEMENTED: design only, gated on Owner rulings.** Baseline `main` @ `e78efb4` (#534, #535, #536 merged). Not legal advice; no R1-R8 ruling is made here. D1, D2, D3 and D6 remain open.

## 1. What changed, in one paragraph

`audit_log` was append-only by application convention only. Migration `0085_audit_integrity_foundation.sql` adds a database guard: a row-level `BEFORE UPDATE OR DELETE` trigger and a statement-level `BEFORE TRUNCATE` trigger, both `ENABLE ALWAYS` (so `session_replication_role` cannot skip them), with a fixed `search_path` and no definer rights. The only permitted change to an audit row is PostgreSQL's own `ON DELETE SET NULL` on `business_id` / `actor_user_id`. Inserts are untouched. No row is rewritten, no privilege is changed, no role is created. **It does not minimize or unlink anything**: erased onboarding events remain re-identifiable through the audit path (section 5).

## 2. Effective runtime privileges (verified)

- Production and staging Hyperdrive origins connect as **`neondb_owner`** (read from the Hyperdrive configs; no secret read, nothing modified). That login owns every table, including `audit_log`.
- Consequence, stated plainly: a trigger cannot stop the table owner, who may `DISABLE`/`DROP` it (tested as an explicit characterization). `REVOKE` is meaningless against an owner, and it would also break the FK `SET NULL` actions, which run as the owner. The 0085 guard therefore stops **application bugs, SQL injection through ordinary DML, accidental maintenance statements and every non-owner role**; it does **not** stop a compromised runtime credential.
- A real boundary needs a **separate non-owner runtime role** (the application connects as a role without ownership and without trigger/DDL rights; migrations keep the owner). That touches every table, grant, migration and the Hyperdrive config, so it is an Owner architecture decision (R8-G below), not something to slip into this block.

## 3. Audit-security dependency matrix (verified against code and SQL)

| Component | Current permission / path | Writes | Personal data exposed | Weakness | Correction here | Compat risk |
|---|---|---|---|---|---|---|
| `audit_log` table | owner = runtime login; no trigger, no REVOKE (before 0085) | INSERT only by code (no UPDATE/DELETE anywhere in `src`, `scripts`, migrations) | `actor_user_id`, `entity_id`, `metadata` (incl. `membershipId` on `customer.onboarded`), `ip_address`, `user_agent`, exact `created_at` | database did not enforce immutability | 0085 guard | one test fixture backdated a row (adjusted); FK `SET NULL` preserved |
| Writers | `repos.auditLog.record / recordReturningId`, `middleware/audit.ts`, services | INSERT | as above | none new | unchanged | none |
| Platform audit API | roles support, billing, admin | read all businesses | `entityId`, full `metadata`, actor email/name, IP, user agent, exact time | cross-tenant by design; broad metadata | none (contract change needs a ruling, R8-F) | n/a |
| Business audit API | `audit:view` + business-wide access, scoped by `businessId` | read own business | raw entries incl. metadata | raw metadata returned | none (R8-F) | n/a |
| Cashier activity | `audit:view` or `loyalty:accounts:view` | read | projection: correlation id, time, branch, actor, action, category, outcome, error code | does not return `membershipId`/`entityId` in the code read | none | n/a |
| `customer_onboarding_events` (0083/0084) | guarded, erasure function only | append / sanctioned UPDATE | links severed on erasure | audit path re-links (section 5) | documented, not removable without a ruling | n/a |
| Erasure roles | no SELECT on `audit_log`, memberships or customers (tested) | none on audit | none | none | verified | none |
| Exports | no audit export endpoint exists (the `forensic.ts` match is Stripe evidence, unrelated) | n/a | n/a | n/a | n/a | n/a |

## 4. Audit write model (verified)

Audit rows are created by normal INSERTs in the same transaction as the business action (`recordReturningId` for the onboarding join). No legitimate runtime path updates or deletes an audit row. The only non-INSERT modification is PostgreSQL's referential action when a business or user row is deleted. Corrections must therefore be **new** rows. No database-triggered audit writers, background audit writers or repair jobs exist in the repository (only application INSERTs). Whether production history contains rows modified by hand cannot be known from the repository: NOT VERIFIED.

## 5. Identity-linkage graph (reproduced on real PostgreSQL)

Before 0084 erasure: `customer_onboarding_events.customer_id/membership_id/consent_grant_id/audit_log_id` link directly.

After erasure (0084) **and with 0085**:
```
erased event (id kept, links NULL, time = UTC day)
   |  audit_log.entity_id = event.id            (audit row untouched, now also immutable)
   v
audit row: metadata.membershipId, branch, source, cashier actor, EXACT created_at
   |  memberships.id = metadata.membershipId
   v
business_customer_memberships.customer_id  ->  customers (phone, name, email)
```
Two independent re-identification paths survive, both tested (`onboarding-event-erasure.integration.test.ts`):
1. **By identifier:** `entity_id` -> `membershipId` -> `customer_id`.
2. **By timing, even if `membershipId` were removed:** the audit row's exact time matches the single membership whose `joined_at` equals it in that business. So removing the metadata field alone would **not** anonymize.

Cashier (`actor_user_id`) is staff data (R3). Branch and source are low-cardinality but can single out a person in a small business (R4). Consent grants and loyalty rows still carry the customer. **Conclusion: D2-R1 plus 0085 is event-level severing plus audit protection, not customer anonymization or erasure. No such claim is made.**

## 6. Model comparison and recommended architecture

| | A. Forensic audit + separate minimized analytics | B. Controlled audited metadata minimization | C. Identifying references in a separate, deletable structure |
|---|---|---|---|
| Audit integrity | preserved | needs a deliberate, audited exception to the 0085 guard | preserved (non-identifying event stays) |
| Privacy | analytics clean; forensic store still identifiable | removes `membershipId` only; **does not stop timing correlation (path 2)** | strongest if timestamps/ids are not co-stored |
| Investigations | intact | reduced for redacted rows | intact until the link is deleted |
| Tenant isolation / financial evidence | unchanged | must never touch financial or security events | unchanged |
| Complexity / migration | medium | one new restricted function + a guard exception (0086) | highest: new table, write-path change, backfill |
| Existing APIs | unchanged | metadata shape changes | metadata shape changes |
| Residual re-identification | audit path remains | timing path remains | timing path remains unless time is also decoupled |

Smallest defensible architecture: **keep 0085 as the foundation (done); do not mutate audit rows.** For minimization prefer **C applied forward-only** (stop writing `membershipId` into new `customer.onboarded` metadata, keep the link only in the erasable event row), **combined with customer-level handling (R6)**, because B alone leaves path 2 and A defers the problem. Nothing reads `metadata.membershipId` in production code (writer and tests only), so the forward change is technically low-risk, but it changes audit content and is gated on R8-B/C below. **Not implemented in this block.**

## 7. Policy-gated redaction design (NON-EXECUTABLE; nothing below exists in the migration)

If R8-B is approved, a separate migration (next free number, now 0086) would add one function, e.g. `audit_minimize_customer_onboarding(business, customer, request_ref)`, following the 0084 pattern:
- `SECURITY DEFINER`, owned by a dedicated NOLOGIN role, `SET search_path = pg_catalog, public`, `REVOKE ... FROM PUBLIC`, `EXECUTE` to a separate NOLOGIN operator role with no members until R5 is decided; no dynamic SQL; no inherited privileges.
- Scope: one business, one customer; candidate rows chosen **only** as `action = 'customer.onboarded'` rows whose `entity_id` is an erased event of that customer in that business (events found while still linked, before erasure, or recorded in the operation row); never other actions, never financial or security events.
- Effect limited to removing `metadata.membershipId` (a fixed key, no free JSON rewrite) and, if R4 requires, generalizing `created_at`; never `actor_user_id` unless R3 says so.
- Same relationship advisory lock as join/leave/withdrawal/erasure; atomic; idempotent; writes a **new** receipt row (counts only, no personal data, request reference pattern-checked), because the original row is changed.
- The 0085 guard would gain a single exception keyed on `current_user = <that owner role>` plus the exact column shape (the same technique as the 0084 event guard); no GUC or marker is trusted.
- Invariants to test before any execution: only the whitelisted key changes; other actions untouched; foreign business untouched; unauthorized role refused; rollback atomic; second run is a no-op; the guard still refuses everything else.
Business owners, admins, managers, staff and cashiers get **no** authority over this; ownership of a business does not confer authority to rewrite historical audit evidence. It must not be callable from the production runtime. Timing correlation (path 2) is not solved by this function; it needs R6/R4.

## 8. Audit API exposure (verified against code) and small-group reidentification

Platform audit (support, billing, admin) returns raw `entityId`, `metadata`, actor identity, IP and user agent across all businesses; the business audit API returns raw rows for its own business to `audit:view` holders; cashier activity returns a projection. Whether each consumer needs raw `entityId`/`membershipId`/IP/exact time is a product ruling (R8-F); **no response contract was changed** to avoid silently breaking consumers. No authorization defect was found: tenant scoping on the business route is by `businessId`; cross-tenant reads exist only in the platform route by design (platform roles). Whether billing should see raw metadata is an open least-privilege question for the Owner.

Small-group risk: business + branch + cashier + source + verification + day (events) or exact time (audit) can single out a person in a low-volume business (the function already reports `residual_singletons`). No numeric suppression threshold is invented: R4.

## 9. Owner decision record (all OPEN; none made here)

| ID | Decision | Notes |
|---|---|---|
| R8-A | Database immutability of audit_log | **Recommended: approve.** Implemented as 0085; technical foundation only; merging it is the approval vehicle |
| R8-B | May historical audit metadata be minimized under a verified erasure process | separate from R8-A; blocks any minimization migration |
| R8-C | Forensic evidence that must remain | decides what B/C may remove |
| R8-D | Who may authorize and execute minimization | blocks operator role activation (R5) |
| R8-E | Records that must stay identifiable and for how long | ties to R1 |
| R8-F | Business/platform audit APIs: raw metadata vs privacy-filtered projections, and whether billing needs raw data | no contract changed |
| R8-G | Separate non-owner runtime database role | only real defence against a compromised runtime credential; large change |
| R1-R7 | retention, trigger, cashier attribution, timestamp/small-group, operator/verification, customer deletion scope, legal | unchanged; D1, D2, D3, D6 open |

Immutability (R8-A) and redaction (R8-B) are separate decisions: approving one is not approval of the other. **Block merging the 0085 foundation:** none beyond normal review. **Block real-customer erasure/minimization processing:** R5 (nobody may run it), R1, R2, R7 before any run, and R6/R8-B/C before any claim of customer anonymity.

## 10. Release implications

Pending bundle on `main`: **0080-0085**; ledger **86** after a P3 run (production is at 0079). D6 must be re-ruled for 0084 and 0085. 0085 is additive and non-destructive (rehearsed: fingerprint of historical audit rows identical before and after as a non-superuser migrator), but it adds a database-level behaviour change: any statement that updates or deletes an audit row now fails. A new release-readiness assessment is required before any P3 (final count, D1 secret, D2 decisions, D3, D6, R8, exact SHA, green exact-head CI, valid recovery snapshot, post-migration verification). No production release authorization is included here.

## 11. Limits that remain

The owner/superuser can disable the guard (R8-G). Both re-identification paths in section 5 remain. `audit_log` still holds exact times, IP, user agent and actor identity. Customer, membership, consent and loyalty rows are untouched. Technical review here is not legal approval.
