# CASHIER-PROD-D2-R1-V1: residual identity linkage and audit options (2026-11-19)

Status: **ASSESSMENT AND CHARACTERIZATION ONLY. No audit data, schema or privilege was changed.** Baseline: `main` @ `addf75b` (#534 and #535 merged by the Owner). Not legal advice; no R1-R7 ruling is made here.

## 1. Finding (verified on a real PostgreSQL database)

D2-R1 severs links inside `customer_onboarding_events`. It does **not** make an erased event unidentifiable, because the join path writes a second record:

`customer-membership.service.ts` records an `audit_log` row `customer.onboarded` in the same transaction with `entity_type = customer_onboarding_event`, **`entity_id` = the event id**, `actor_user_id` = the cashier (assisted joins), exact `created_at`, and `metadata = {source, branchId, membershipId, rejoin, verificationState}`. Erasure nulls the event's `audit_log_id`, but the audit row still points at the event and names the membership; `business_customer_memberships.customer_id` then names the customer.

Chain after erasure: `erased event.id` -> `audit_log.entity_id` -> `metadata.membershipId` -> `memberships.customer_id` -> `customers` (phone, name, email), plus an **exact timestamp** that defeats the UTC-day generalization.

Proof: integration tests `residual linkage through audit_log` in `onboarding-event-erasure.integration.test.ts` (29/29 pass) assert this chain on a real database after a successful erasure. They are characterization tests: they must be updated deliberately if the audit path is ever minimized.

## 2. Who can reach it

| Reader | Path | Sees |
|---|---|---|
| Platform support, billing, admin | `GET` platform audit log (`audit-log.routes.ts`) | all businesses; `entityId`, full `metadata`, exact `createdAt`, actor |
| Business Owner/Admin with `audit:view` (business-wide access) | `GET /businesses/audit-log` | own business; returns the raw audit entries, including metadata |
| Business Owner/Admin/Manager | cashier-activity route | a projection (correlation id, timestamp, branch, actor, action, category, outcome, error code); the projection code read does not return `membershipId` or `entityId` |
| Erasure operator and owner roles | database | **cannot read** `audit_log`, memberships or customers (tested: `has_table_privilege` false) |
| Application database login | database | full UPDATE/DELETE/TRUNCATE on `audit_log` (see section 3) |

The customer's own business already knows its members, so the **new** exposure is mainly platform-level readers and any later use of erased-event data for analytics. It is still a re-identification path and must not be described as anonymization.

## 3. Correction to the earlier report

The earlier statement that `audit_log` is "append-only" described the application's intent. **The database does not enforce it**: no trigger, no REVOKE; the application login holds `INSERT, SELECT, UPDATE, DELETE, TRUNCATE`. Nothing in D2-R1 changed that. This is a pre-existing property, flagged here as a separate governance finding (immutable-audit claims should not be made until it is enforced or the claim is withdrawn).

## 4. Classification of what remains after an erasure

| Item | Event-level anonymization (D2-R1) | Customer erasure (not implemented) |
|---|---|---|
| Customer link on the event | removed | n/a |
| Membership, consent grant, reference on the event | removed | n/a |
| Audit row `customer.onboarded` (entity id, membershipId, exact time, cashier actor) | **retained, re-links the event** | requires a separate decision |
| Membership, consent grants, loyalty ledger, customer row | retained | requires R6 |
| Cashier link | retained by default (R3) | n/a |

## 5. Options (evaluated; none implemented)

| | A. Retain audit rows under a separately approved obligation | B. Controlled audit-metadata minimization | C. Separate identifying audit references from minimum long-term evidence |
|---|---|---|---|
| What | Keep rows; state the D2-R1 guarantee as event-level only | A second restricted, audited function that redacts `membershipId` (and decouples `entity_id`/`created_at`) in matching audit rows | Stop writing membership/event identifiers into general audit metadata; keep a minimal evidence record plus a short-retention identifying side table |
| Security | no change; audit evidence intact | strongest privacy gain; weakens evidentiary value; needs the audit table made DB-immutable first, else an application login can already redact silently | best long-term; larger blast radius |
| Privacy | event stays re-identifiable for audit readers | event becomes unlinkable once membership is also handled | designed in |
| Existing invariants | none touched | introduces a deliberate exception to audit integrity (needs governance approval) | changes the write path and every audit reader |
| Compliance | defensible only if a retention obligation is documented (R1, R7) | depends on R7 (what must be preserved) | depends on R1, R7 |
| Referential integrity | none | audit has no FK to the event; low risk | new table and keys |
| Roles/tenant isolation | unchanged | new operator privilege on `audit_log` (today the erasure roles have none, tested) | new roles |
| Concurrency | none | must take the same relationship advisory lock | at write time only |
| Complexity / production | none | one more migration (0085) in the release bundle | migration plus data backfill of existing rows |

Recommendation: **A now** (this document and the corrected guarantee), and decide B or C only after the Owner rules on R1, R3, R6, R7 and on the audit-immutability question. Implementing B or C without those rulings would either invent a retention policy or silently weaken audit records, which this block is not authorized to do. Because B would be a **new** migration, the next free number is 0085 (0084 is on `main`); the release bundle would then be 0080-0085.

## 6. Residual singleton and small-group risk (unchanged, restated)

Day-level time plus branch, source, cashier and verification state can single out a person in a low-volume business; the function reports `residual_singletons`. The audit path above is stronger than any of these. Whether the reporting layer must suppress small groups, and at what threshold, is R4 and remains open.

## 7. Release bundle consequence

`main` now contains migration 0084. The Owner's earlier D6 approval question covered 0080-0083. Production ledger is at 0079; a P3 run takes whatever `main` holds (0080-0084, ledger 85), so **D6 must be re-ruled for 0084** and the P3 plan and P2 recovery steps re-checked before any migration run. `docs/CASHIER-PRODUCTION-RELEASE.md` is updated to say so.

## 8. Decisions still open

R1 retention; R2 trigger; R3 cashier attribution; R4 timestamp/branch granularity and small-group suppression; R5 who may run an erasure and how a request is verified (operator role stays unassigned); R6 customer-account deletion and its audit dependencies; R7 applicable law. Plus a new one: **R8, whether `audit_log` must be made database-immutable and whether identifying audit metadata may be minimized.** D1, D2, D3 and D6 are unresolved. Blocking the technical foundation: nothing further (it is merged and dormant). Blocking real-customer processing: R5 (nobody may run it), and R1, R2, R7 before any erasure is performed; R6/R8 before any claim of customer erasure or anonymity is made.
