# CASHIER-PROD-D2: onboarding-event retention and erasure, proposed decision record (2026-11-19)

Status: **PROPOSED DECISION RECORD. D2 is NOT resolved.** It becomes resolved only by an explicit Owner ruling plus the technical controls in section 9. Nothing here is legal advice or a legal conclusion; every legal point is marked for qualified review. No code, schema, migration or production change was made. Baseline: `main` @ `91aa915`; migration 0083 is **not applied in production** (production ledger: 80, last 0079).
Companion: `CASHIER_PROD_P2R_RESTORE_DRILL_RECORD.md` (Part A of the same block).

## 1. Current architecture (verified in code and SQL)

`customer_onboarding_events` (migration 0083, `src/db/schema/customer-onboarding-events.ts`):

| Column | Meaning | Links a person? |
|---|---|---|
| `customer_id` (NOT NULL, FK RESTRICT) | the customer who joined | **Yes** (to `customers`, which holds phone, full name, email) |
| `membership_id` (NOT NULL, FK RESTRICT) | the business membership | **Yes** (membership has `customer_id`) |
| `consent_grant_id` (FK RESTRICT) | the `JOIN_LOYALTY` consent | **Yes** (grant has `customer_id`) |
| `cashier_user_id` (FK RESTRICT, only for cashier-assisted) | staff member who invited | Yes (staff personal data) |
| `business_id`, `branch_id` (RESTRICT) | where it happened | No |
| `source`, `verification_state`, `is_rejoin` | how, and what the customer had verified | No (low-cardinality attributes) |
| `reference` | QR code id, or the single-use invitation id | Indirect (invitation id is an opaque id) |
| `occurred_at`, `recorded_at` (second precision) | when | Indirect when combined with other data |
| `audit_log_id` (FK RESTRICT) | audit row `customer.onboarded` | The audit row holds `source`, `branchId`, `membershipId`, `rejoin`, `verificationState`, and `actor_user_id` for assisted joins |

Guards (`ENABLE ALWAYS`, so even `session_replication_role = replica` cannot bypass): the BEFORE trigger raises `ONBOARDING_EVENT_APPEND_ONLY` on every UPDATE and DELETE; TRUNCATE is denied; INSERT is checked for tenant consistency (membership, branch, consent, audit, cashier eligibility).

### What is recorded, and when (implemented behaviour)

| Operation | Records an event? | Evidence |
|---|---|---|
| Customer joins through a **business QR** | **Yes**, source `business_qr`, branch and QR id; same transaction as the membership and consent | `customer-membership.service.ts` (attribution passed by `customer-membership.routes.ts`) |
| Customer accepts a **cashier-assisted invitation** | **Yes**, source `cashier_assisted`, with the cashier, branch and invitation id | same |
| An idempotent repeat of a join on an already-active membership | **No** (only a new occurrence records) | `isNewOccurrence` |
| Customer **leaves** a business | **No event.** Membership becomes `left`, spending ends; the earlier events stay | `leave()` |
| Customer **rejoins** the same business | **Yes**, a new event with `is_rejoin = true`; the earlier event stays | `isRejoin` |
| Customer **withdraws consent** | **No event.** Withdrawal ends the membership; earlier events stay | `consent-withdrawal.service.ts` |
| Customer **requests deletion or erasure** | **Not implemented.** No code path deletes a customer; `customers` has no soft-delete columns; no erasure flow exists | code search; `docs/OPERATIONS.md` "Data retention" |
| Customer, cashier, branch, business **hard delete** (database level only) | **Blocked** while events exist (RESTRICT) | 0083 foreign keys |

Related existing foreign keys: `business_customer_memberships.customer_id` and `consent_grants.customer_id` CASCADE from `customers`; `loyalty_accounts.membership_id` is RESTRICT; the events table is RESTRICT on all of its references. `audit_log` references to business and user are `ON DELETE SET NULL` and the table is append-only.

Not stored in an event: the invitation token, any customer data in the invitation, any cashier-typed customer detail, IP address or device.

## 2. The verified governance conflict

The design deliberately makes history un-editable (audit integrity) and keeps hard references (tenant integrity). The same properties mean that **no event, and therefore no customer, cashier, membership, branch or business it references, can be physically deleted**, and no personal link can be removed, while the event exists. There is no present breach (no data exists in production, and no erasure feature exists), but a future erasure or retention obligation could not be met without a reviewed change. The legal position is unresolved: `docs/PRODUCTION-CHECKLIST.md` still lists the privacy policy, terms and data-processing position as an open item, `docs/OPERATIONS.md` states that no retention policy and no erasure flow exist, and no jurisdiction determination is recorded in the repository. The product operates under a `.uk` domain; that is a fact, not a legal conclusion, and **applicable law (for example UK or EU data-protection law, or others) requires qualified legal review**.

### Conflict matrix

| Requirement | Tables and operations affected | Current state | Conflict |
|---|---|---|---|
| A. Audit integrity: history must not be silently rewritten | `customer_onboarding_events` (append-only), `audit_log` | Enforced by triggers | None; this is the reason for the design |
| B. Privacy: no retention without purpose and basis | events, `customers`, `business_customer_memberships`, `consent_grants`, `audit_log.metadata.membershipId` | Purpose and basis not documented; consent wording coverage of branch, cashier and source not confirmed | Open (legal) |
| C. Erasure and retention enforceable | all of the above | No erasure flow; RESTRICT blocks deleting the customer, cashier, branch, business; no retention period or job | **Conflict**: erasure cannot be carried out |
| D. Business isolation | events (tenant-consistency guard, business-scoped indexes), `/analytics/onboarding` (counts only, `analytics:view`) | Enforced and tested | None |
| E. Operational continuity: loyalty and financial records must not be corrupted | `loyalty_accounts` (RESTRICT on membership), `loyalty_transactions` | Loyalty ledgers reference accounts, not events | An erasure design must not delete or orphan loyalty rows; erasure of a *customer* is a larger decision than erasure of *event links* |

## 3. Options evaluated

Common baseline: an event is personal data of the customer (and, for assisted joins, of the cashier) because it can be linked through `customer_id`, `membership_id`, `consent_grant_id` and `cashier_user_id`. Replacing identifiers with a hash or pseudonym **does not** make the record anonymous (the mapping or the surrounding records still single the person out); only **severing** the links so that no record can re-link them does, and even then low-cardinality combinations (branch, minute-level time, source) can single out a person in a small business, so timestamps should be coarsened.

| | Option A: controlled anonymization | Option B: dedicated audited erasure operation | Option C: retention-based separation |
|---|---|---|---|
| Idea | Sever the personal links in an event, keep non-identifying business statistics | A single, privileged, audited transaction that erases or transforms eligible customer-related records, leaving a minimal erasure audit row | Keep identifiable attribution only for a period; maintain a separate aggregate (business, branch, source, day, count) for long-term analytics; delete or expire the identifiable rows |
| Privacy | Strong if all four links and fine timestamps are removed | Strong (also a vehicle for deleting the customer) | Strongest after expiry |
| Security | Needs a narrow exception to the append-only guard | A privilege boundary that must not become arbitrary rewriting | Smaller exception (delete expired rows only) plus a new aggregate store |
| Database changes | `customer_id`, `membership_id`, `consent_grant_id`, `cashier_user_id` nullable; relaxed CHECKs (assisted rows need `cashier_user_id` and `reference` today); FK rule change or guard change; new erasure function and guard exception | Same exception, plus customer-level deletion choreography (cascade order with the RESTRICT on `loyalty_accounts.membership_id`) | New aggregate table, writer (trigger or application), backfill, retention job, changed analytics source |
| Transaction behaviour | One function, row-locked per customer, one transaction | One larger transaction | A scheduled job plus a dual write |
| Referential integrity | Preserved: rows remain valid with NULL links; RESTRICT no longer blocks deletion afterwards | Preserved if ordered correctly | Preserved |
| Audit integrity | Event rows stay; only the link columns change under a guard that permits nothing else; erasure itself is audited without personal data | Same, plus an erasure record | Aggregate is derived, identifiable history is expired by policy |
| Tenant isolation | Unchanged (business and branch kept) | Must be re-checked per business | Aggregate must be business-scoped |
| Complexity / cost | Small to medium (one migration, one function, tests) | Medium to large | Largest |
| Migration risk | Medium (alters a guarded table) | Medium to high | Highest |
| Compatibility with current app | High: reports use business, branch, source, cashier counts; per-cashier counts would lose rows after cashier links are severed (decision) | High | Lower: analytics source changes |

## 4. Recommendation (smallest defensible architecture)

**Option A, delivered through a narrow version of Option B's privilege boundary**, and **not** Option C. Concretely:

1. Anonymize an event by setting `customer_id`, `membership_id` and `consent_grant_id` to NULL (the three links that identify the customer), and, **as a separate Owner decision**, `cashier_user_id` for staff erasure. Do **not** replace them with hashes or pseudonyms. Coarsen `occurred_at` and `recorded_at` to the day on anonymization (decision), and keep `business_id`, `branch_id`, `source`, `verification_state`, `is_rejoin`.
2. Keep the append-only guard for every other change: a new migration (allocated at implementation time; the next free number is 0084) replaces the guard so that **exactly one UPDATE shape is permitted**, and only when it is issued from a single `SECURITY DEFINER` function (not callable by the application's ordinary role without an explicit grant to a dedicated erasure role) that sets a transaction-local marker. Any other UPDATE or DELETE still raises `ONBOARDING_EVENT_APPEND_ONLY`. The guard keeps its INSERT consistency checks, adapted for nullable links.
3. The function takes a customer id, locks that customer's rows (same order as leave and consent withdrawal), anonymizes that customer's events, and writes **one erasure audit row that contains counts and a request reference but no customer identifier or contact detail** (this preserves "who erased what, when" without keeping the person).
4. Customer-level deletion (removing `customers`, memberships, consent and loyalty data) is a **separate decision**: erasing event links makes it unblockable, but loyalty-ledger consequences are out of scope here and must not be bundled.
5. A retention schedule is **optional and Owner-chosen**: either "on request only" (Option D of the earlier record), or "on request and after a fixed period" using the same function from a scheduled job. No period is proposed; none should be assumed.
6. `audit_log` rows `customer.onboarded` hold `membershipId` in metadata; once the membership no longer exists or is unlinked, that id is an orphan reference. Whether to keep audit retention separate (recommended, per the existing record) is a legal-review question.

Why not the others: Option B alone is larger than needed (customer deletion is a different problem). Option C duplicates data and changes the analytics source for a feature that currently has no data.

## 5. Proposed retention criteria (for Owner and legal review; no period invented)

| Topic | Proposal | Status |
|---|---|---|
| Purpose | Attribute a customer's joining of a business to the branch, channel and (for assisted joins) the staff member who helped, for the business's own counts and for dispute handling | To confirm |
| Categories | Customer, membership and consent references; branch; source; verification bucket; cashier reference (assisted only); timestamps | Verified from schema |
| Lawful basis | To be determined and documented by the Owner with legal advice (consent for the join exists; whether it also covers recording branch, cashier and source is not confirmed) | **Legal review required** |
| Access | Business roles with `analytics:view` see counts only, scoped to their business and branch; no endpoint returns customer identifiers from this table | Verified |
| Retention | On request, and optionally after a period chosen by the Owner; until anonymization the event is retained for the life of the membership relationship | **Owner decision** |
| Deletion/anonymization triggers | Customer erasure request; consent withdrawal (decision: anonymize on withdrawal or only on request); staff erasure; business closure | **Owner decision** |
| Legal holds | A hold flag or an operational procedure must be able to suspend anonymization for a named customer | Not built; decision |
| Audit retention | Keep security-relevant audit rows (issuance, revocation, replay, rate limiting) under their own retention, not purged by an attribution erasure | Proposed |
| Data minimization | Anonymize to day granularity; do not add IP or device; keep invitations opaque | Proposed |
| Responsibilities | Owner: policy and legal basis; engineering: function, tests, runbook; operator: executes erasure with a request reference | To assign |
| Verification and monitoring | Quarterly count of un-anonymized events past the retention criteria; test that no event references an erased customer | Proposed |

## 6. Legal and policy questions needing qualified review

1. Which jurisdictions' data-protection law applies to the Owner's business and to customers of the businesses on the platform; is Echo Grid a controller, processor or both for these events?
2. Whether the existing `JOIN_LOYALTY` consent wording covers recording branch, cashier and source, and whether a separate notice is needed.
3. Whether event timestamps and branch together are personal data in small businesses, and the granularity to keep.
4. Whether anonymization (link severing) satisfies the erasure obligation for events, and what must happen to the related membership, consent and loyalty rows.
5. Any statutory or contractual retention obligations for loyalty or financial records that bear on customer-level deletion.
6. Whether the privacy policy and terms (open in `PRODUCTION-CHECKLIST.md`) must exist before the first real customer joins.

## 7. Required development before onboarding is activated (a follow-up block; not done here)

1. **Schema** (new migration, number allocated then; do not edit 0083): nullable link columns; adjusted CHECKs; adjusted unique index for assisted invitations (it uses `reference`); replacement guard with the single permitted anonymizing transition; erasure function and a dedicated role; an erasure audit action.
2. **Application**: an operator-run erasure entry point (not a public route), customer erasure request intake as a later product decision.
3. **0083 compatibility**: the migration is additive and already reviewed; the follow-up migration is applied after it. If 0083 is applied to production first, the follow-up migration alters an empty or near-empty table.
4. **Authorization boundaries**: the function is the only code that may set the transaction-local marker; its execution is granted to one role; no route calls it.
5. **Tenant isolation**: the function takes a customer id only, and a business scope parameter for business-closure cases; it never reads across tenants for reporting.
6. **Audit handling**: one erasure row with counts and the request reference; no personal data; the `customer.onboarded` audit rows are retained.
7. **Regression tests**: append-only still holds for all other UPDATE/DELETE/TRUNCATE; anonymization permitted only via the function; the guard cannot be bypassed by setting the marker directly; assisted-invitation single use still enforced; analytics counts keep business and branch totals after anonymization; RESTRICT no longer blocks deleting an anonymized customer; concurrency with join, leave and consent withdrawal.
8. **Security and adversarial tests**: a business role cannot call it; a cashier session cannot; a crafted UPDATE that changes other columns is refused; a cross-business customer id changes nothing.
9. **Deployment prerequisites**: the Owner ruling, legal review of section 6, a snapshot, and a rehearsal on a restored recovery branch (the P2R restore drill branch is a suitable rehearsal source).

## 8. Production activation implications

- Applying migration 0083 creates an empty table and guards; it records nothing by itself.
- Recording begins when the **new application code** is live **and** a customer joins. Production currently has 0 customers, 0 memberships and 0 active branches (no branch means no business QR code), so no event can be written until the Owner creates a branch and QR codes and customers join.
- Therefore the technical remediation is needed **before real customer onboarding is activated**, not before the schema migration. This record's recommendation: apply 0083 only after the Owner rules on this document; do not issue business QR codes or onboard real customers until the follow-up erasure control is verified, or the Owner explicitly accepts the interim position in writing (no erasure mechanism for events yet, recording a documented basis and retention statement).
- The release is **blocked on the Owner ruling in section 9**. If the Owner prefers strict ordering (control before any deployment of the 0083 code), the follow-up block precedes P3.

## 9. Owner decisions still required

1. Choose the architecture (recommended: Option A through a narrow audited function).
2. Whether cashier links are severed on staff erasure or kept while the staff account exists.
3. Trigger: on request only, or also after a fixed period (the Owner names the period with legal input; none is proposed here).
4. Whether consent withdrawal triggers anonymization or only a request does.
5. Timestamp granularity after anonymization (recommended: day).
6. Who executes erasure and who approves each request.
7. Whether to accept the interim position in section 8 (no real customer onboarding until the control exists) or require the control before P3.
8. Confirmation that the legal questions in section 6 have been answered by qualified advisers, with the date and the adviser.

D2 stays **UNRESOLVED** until items 1 to 8 are recorded and the section 7 development (if required by the ruling) is verified.

## 10. D1, D3 and D6 carried forward (not decided here)

- **D1** (`CLIENT_ATTRIBUTION_SECRET`): presence on `echo-grid-feedback-api`, `echo-grid-feedback-web` and the future `echo-grid-feedback-cashier` Worker is **NOT VERIFIED**; the available Cloudflare tools expose no secret names. Owner steps (names only, never values): `wrangler secret list --name echo-grid-feedback-api`, `--name echo-grid-feedback-web`, and after the cashier Worker exists `--name echo-grid-feedback-cashier`. If absent, sign-in still works but every sign-in shares one limiter bucket of 10 per minute.
- **D3** (lockout): five failures in 15 minutes lock a managed identity for 15 minutes; only an administrator credential reset unlocks it; anyone who knows a business code and a username can lock that cashier. Proposed seven-day pilot (not accepted): one dedicated test cashier with a non-obvious username; five-failure policy unchanged; administrator reset tested once before the pilot; daily read-only check of locked identities and failed-login counts; incident steps (reset the credential; rotate the business code if it is suspected known; disable the account if abuse continues); exit criteria: seven days without an unexplained lock and the reset path proven; explicit Owner acceptance recorded before the account is created. Not accepted automatically.
- **D6** (release bundle): the Owner must accept, as one scope: migrations 0080, 0081, 0082, 0083; the main-based application delta (78 commits at P1); Split 01 customer consent and membership behaviour changes; dormant B2B and business-profile tables; cashier identity, session and branch features; and customer onboarding events (this document). Not approved automatically.
