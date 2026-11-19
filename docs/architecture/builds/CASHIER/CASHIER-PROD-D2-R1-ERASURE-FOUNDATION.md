# CASHIER-PROD-D2-R1: controlled onboarding-event anonymization, technical foundation (2026-11-19)

Status: **TECHNICAL FOUNDATION IMPLEMENTED AND TESTED LOCALLY. NOT APPLIED to any shared database. NOT a policy, legal or retention approval.** Migration `0084_d2r1_onboarding_event_erasure.sql`. Baseline: `main` @ `91aa915`. Depends on the proposed decision record in PR #534 (`CASHIER-PROD-D2-RETENTION-ERASURE-DECISION.md`, still open, not modified here). Production ledger is at 0079; staging, production and the retained recovery branch were not touched.

## 1. What this adds, in one paragraph

A restricted PostgreSQL function, `public.onboarding_erase_customer_events(business, customer, request_ref, sever_cashier)`, that irreversibly severs the personal links (customer, membership, consent grant, audit row, QR/invitation reference) of one customer's onboarding events in one business, generalizes their timestamps to the UTC day, marks them erased, and writes one minimal, append-only audit row with counts and no personal data. Nothing else about `customer_onboarding_events` changes: UPDATE, DELETE and TRUNCATE stay refused; the only exception is that one transition, and only when run by the function's owner role. There is **no API route and no application caller**: invocation is operator-controlled and blocked until the Owner approves a workflow and grants the operator role.

## 2. Reconciled facts (verified in code and SQL, not from reports)

- `main` `91aa915`; journal 84 entries (last 0083); **0084 was free**; PR #534 open (draft); no other open PR.
- 0083: append-only guard `ENABLE ALWAYS`; FKs RESTRICT; tenant-consistency checks on INSERT; the same advisory lock key as join, leave and consent withdrawal (`customer_business_relationship:<customer>:<business>`, `membership-lifecycle.ts`).
- Events are appended on every business-QR join and every cashier-assisted join; leave and consent withdrawal append nothing; rejoin appends another event; no code deletes or erases customers (`customers` has no soft-delete columns).
- Privilege pattern: migrations 0061 and 0062 already create NOLOGIN internal roles, own SECURITY DEFINER functions with them, set a fixed `search_path`, revoke from PUBLIC, grant EXECUTE to a named role, and use a temporary membership/CREATE grant for a non-superuser migrator that is removed at the end. 0084 follows that pattern exactly.
- Readers: `CustomerOnboardingEventRepository.summarize` (analytics route `/analytics/onboarding`, counts only), `assistedInviteUsed`, `listForMembership`; tests `customer-onboarding-attribution`, `cashier-onboarding-invite`.
- The tenant-reference gate `scripts/gate2-tenant-reference-precheck.mjs` classifies every tenant-to-tenant foreign key; the new `erasure_operation_id` key is classified `GUARDED_BY_TRIGGER` and the guard enforces it.

## 3. Data classification of every event field

| Field | Identifies a person? | Linked to another personal record? | Needed after erasure? | Action on erasure | Reporting effect |
|---|---|---|---|---|---|
| `id` | No (random) | No | Yes (row identity) | kept | none |
| `customer_id` | **Yes, directly** (pseudonymous key to `customers`: phone, name, email) | `customers` | No | **severed (NULL)** | distinct-customer counts exclude the event |
| `membership_id` | **Yes** (membership holds `customer_id`) | memberships | No | **severed** | none |
| `consent_grant_id` | **Yes** (grant holds `customer_id`, metadata has the membership id) | consent_grants | No (the grant itself stays) | **severed** | none |
| `cashier_user_id` | Yes: **staff** personal data | users | **Owner decision R3** | **kept by default; severed only if the operator passes `sever_cashier = true`** | a severed assisted event leaves the per-cashier breakdown, stays in all totals |
| `business_id` | No | tenant | Yes (tenant isolation, counts) | kept | none |
| `branch_id` | Indirect in tiny businesses (see section 8) | branches | Yes for branch counts | kept | none |
| `source`, `verification_state`, `is_rejoin` | No (low-cardinality attributes), indirect when combined | none | Yes for counts | kept | none |
| `reference` (QR id or one-time invitation id) | Indirect: an invitation id ties the event to the issuance audit row (cashier, session, minute) | audit_log (issuance), memberships summary | No | **severed (NULL)** | none; the invitation single-use index no longer holds it (so assisted events younger than 15 minutes are deferred, section 6) |
| `occurred_at`, `recorded_at` | Indirect (second precision) | audit, sessions | Day granularity is the proposal (R4) | **generalized to the UTC day** | date-range reports still work at day level |
| `audit_log_id` | Link to `customer.onboarded` audit row whose metadata carries the membership id | audit_log | No | **severed on the event** (the audit row itself is append-only and untouched, see section 9) | none |
| `erased_at`, `erasure_operation_id` (new) | No | the operation row (counts only) | Yes (state marker) | set | `erasedEvents` count |

A hash would not make `customer_id` anonymous, so no identifier is replaced by a hash or pseudonym: links are severed, not transformed.

## 4. Migration 0084 (additive; 0083 is not edited)

- New table `onboarding_erasure_operations`: id, nullable business id (SET NULL), `request_ref`, `operator_role` (the database `session_user`, never supplied by the caller), counts (erased, deferred, residual singletons), `cashier_severed`, outcome (`completed`, `partial`, `noop`), `created_at`. **No customer, membership or contact identifier.** Append-only (UPDATE, DELETE, TRUNCATE refused, `ENABLE ALWAYS`). `request_ref` is pattern-checked (`[A-Za-z0-9._:-]{1,64}`) so free text and contact details cannot be stored.
- `customer_onboarding_events`: `customer_id` and `membership_id` become nullable; new `erased_at`, `erasure_operation_id`; checks replaced so an event is either fully linked (never erased) or fully severed; the cashier and assisted-reference checks gain the erased exception; the existing unique index (invite once) is unchanged and ignores NULL references.
- The guard function is replaced **in place** (trigger and `ENABLE ALWAYS` untouched): INSERT checks are kept verbatim and an INSERT can no longer carry erased state; DELETE is always refused; UPDATE is refused unless `current_user = 'onboarding_erasure_owner'` **and** the change is exactly the sanctioned shape: `erased_at` and the operation set, all personal links NULL, `occurred_at` and `recorded_at` equal to the UTC day of the old values, cashier unchanged or NULL, and `id`, `business_id`, `branch_id`, `source`, `verification_state`, `is_rejoin` unchanged, on a row not already erased, with an operation row of the **same business**.
- Roles (NOLOGIN, non-superuser, no BYPASSRLS, created idempotently; no login, password or membership): `onboarding_erasure_owner` (owns the function; column-level UPDATE on the ten severable columns only, SELECT on events, INSERT/SELECT on the audit table; nobody is a member) and `onboarding_erasure_operator` (EXECUTE on the function and SELECT on the audit table; no table privilege on the events). The function is `SECURITY DEFINER`, `SET search_path = pg_catalog, public`, EXECUTE revoked from PUBLIC.

Compatibility: backward compatible with the approved sequence (0080-0083 then 0084): the new columns are nullable/defaulted and no existing application query changes behaviour; the application INSERT type excludes erasure fields. **0084 would become part of the production release bundle**, so D6 must be re-stated as 0080-0084 if the Owner adopts it.

## 5. Privilege model and why the exception cannot be forged

The guard trusts **no session variable, marker or identifier**; it checks `current_user`. Inside the SECURITY DEFINER function `current_user` is the owner role; an ordinary session cannot set it (`SET ROLE` needs membership, and nobody is a member). Tests show that `SET app.* / echogrid.*` markers, `session_replication_role = replica` (even as superuser; the trigger is `ENABLE ALWAYS`), forged operation ids, a wrong-business operation id, a re-pointed customer id, partial severing and a second transition are all refused, including when run as the owner role itself. **Residual, stated plainly:** a database superuser can alter or drop the trigger; and the application's real database login (Neon `neondb_owner`) holds ADMIN OPTION (inherit and set false) on roles it creates, so a compromised owner connection could `GRANT` itself the roles, which is a deliberate, visible statement and is database-administrator authority that no in-database control can resist. The control stops application bugs, injection through ordinary queries and accidental use; it does not stop a compromised administrator login.

Authorization of a *request* cannot be established from existing infrastructure: the function cannot verify that a customer really asked. So it only operates for logins the Owner has made members of `onboarding_erasure_operator`, records who ran it and a request reference, and **invocation stays blocked until the Owner approves an operator workflow (R5)**.

## 6. Behaviour of the function

One transaction: validate arguments, take the same advisory lock as join/leave/withdrawal, lock the candidate rows, write the audit row, perform the guarded UPDATE, verify the row count. Any failure rolls back everything (tested with an injected failure: nothing erased, no audit row). Idempotent: a repeat finds nothing and records a `noop`. Scoped by arguments only: no dynamic SQL, no arbitrary table, predicate or tenant; another business's events and other customers' events are untouched. An assisted-invitation event **younger than 15 minutes is deferred** (an invitation lives 10 minutes, and erasing its id earlier would let the single-use check be bypassed); re-running later erases it, and the outcome is `partial`. Customer rejoin after erasure creates a new, fully linked event (a legitimate new onboarding), the old one stays erased, and no erased relationship is silently recreated.

## 7. Reporting compatibility

Event, branch, source and rejoin totals are unchanged by erasure. `uniqueCustomers` **excludes erased events and under-counts**; the summary now returns `totals.erasedEvents` so consumers can see how many events are affected. Distinct-customer figures for erased history are **unavailable by design** and are never estimated. A severed assisted event no longer appears in `byCashier` but stays in every total. No query returns a customer identifier.

## 8. Re-identification: tested, not assumed

The function returns and records `residual_singletons`: erased events whose remaining attributes (business, branch, source, cashier if kept, UTC day, verification state, rejoin) are unique among erased events of the business. Tests show a lone event in a small business is flagged (1), and that the flag clears as more events share the bucket; day-level time alone is therefore **not** sufficient in low-volume businesses, and the operator is told. Whether to also drop the branch or generalize further is a policy decision (R4).

## 9. Residual personal-data paths that this block does NOT close (dependencies, not shortcuts)

1. `audit_log` row `customer.onboarded` keeps `membershipId` in its metadata; the membership row still references the customer. Until the membership is deleted or anonymized (customer-level deletion, R6) the event is unlinked but an audit row can still lead to the customer. `audit_log` is append-only and was not changed.
2. `consent_grants.metadata` stores the membership id and onboarding reference; `business_customer_memberships.onboarding_*` summary columns hold the current relationship's reference.
3. `customers`, memberships, consent grants and loyalty records still hold the customer's data. Erasing event links removes the RESTRICT blocker for those deletes; deleting them (and the loyalty-ledger consequences) is a separate block.
4. The cashier link is retained by default: it identifies staff, not the customer, and is an R3 decision.

## 10. Test evidence (local disposable PostgreSQL; labelled development evidence)

Real-database suite `onboarding-event-erasure.integration.test.ts` (27 tests) covers: guard triggers `ENABLE ALWAYS`; roles safe and memberless; function owner, SECURITY DEFINER, fixed `search_path`, EXECUTE only for the operator; column-level privileges; ordinary UPDATE/DELETE/TRUNCATE refused for superuser and an ordinary role; erased state not insertable; unauthorized invocation; markers and replica role do not open the exception; the owner role itself limited to the one transition (including the foreign-business operation id); minimal severing and day generalization; retained attributes; untouched bystander, other-business and loyalty/consent/membership rows; idempotence; wrong business and unknown customer; argument validation; hostile `search_path`; atomic rollback; cashier retained by default and severed on request; fresh invitation deferral; concurrent erasures (6 at once: one does the work); join first then erase; erase first then rejoin (no resurrection); leave racing erase (8 rounds); consent withdrawal racing erase; reporting; singleton flag; no residual identifier in any column; audit table append-only and column list. Four mutation checks (guard trusts any role; no advisory lock; business scope ignored; no invitation deferral) each failed the suite and the restored code passes. The existing onboarding suites pass (the one reporting assertion gained the additive `erasedEvents` field).

Rehearsal on a **production-shaped schema as a non-superuser migrator** (separate throwaway PostgreSQL cluster; `CREATEROLE` only, like Neon): 0000-0079 applied, production-shaped seed (1 admin user, 1 business, 4 roles, the 34 production permission keys, 85 grants, 0 active branches), then 0080, 0081, 0082, 0083, 0084 applied in order (80, 58, 49, 62 and 58 ms); the identifier fingerprint was identical before and after; `onboarding_erasure_owner` owns the function, EXECUTE is denied to the migrator, `SET ROLE` is denied, UPDATE is refused, the triggers are `ENABLE ALWAYS`, the schema CREATE grant was removed again.

## 11. Remaining policy and legal decisions (reserved for the Owner and qualified advice; none made here)

- R1 retention duration or criteria; R2 erasure trigger (request, expiry, other lifecycle event); R3 cashier attribution (retained, severed, or separate employment/audit retention); R4 timestamp and branch granularity after erasure, including the singleton findings; R5 who may request or run an erasure and how authorization is evidenced (the operator role is empty until then); R6 whether customer-account deletion is in scope; R7 applicable privacy law, notices, contracts and controller/processor roles (qualified legal review). The defaults implemented (cashier kept, day granularity, 15-minute invitation deferral) are technical defaults, not approvals.

## 12. Release implications

Migration 0084 is **not applied anywhere shared**. If adopted, P3 becomes 0080-0084 and re-requires the Owner's D6 approval plus a re-run of the P2 recovery steps for the new migration (a fresh snapshot is only needed if production data changed materially; the existing snapshot predates 0080-0084 and remains valid as the pre-migration point). D1, D2, D3 and D6 stay open. P3 remains blocked until the Owner rules on D2 and accepts the foundation. No operator workflow, role membership, production invocation or erasure request exists.
