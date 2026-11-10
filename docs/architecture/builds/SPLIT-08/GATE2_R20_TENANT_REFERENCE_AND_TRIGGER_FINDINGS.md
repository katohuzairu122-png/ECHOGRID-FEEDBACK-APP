# Gate 2 R20 — Findings for the broker track: cross-tenant references and invoker-rights triggers

**DEVELOPMENT / DISPOSABLE EVIDENCE ONLY. Documentation of two verified findings. No migration, no code, no deployment, no staging or production access, no Hyperdrive or credential change.**

## Baseline
- Authoritative main: `c6bde3572b2e2d6c7573e1660849c0bb9c69a848` (2026-11-10). 67 committed migrations (0000–0066); the schema is replayed on a fresh disposable PostgreSQL 18.6 for every statement below. Nothing was run against Neon.
- Origin: an experiment on a shared-login, claim-gated RLS design (since dropped: it conflicts with the documented direction of a nonowner role with no direct tenant-table CRUD and only approved broker operations; main already has an R12 broker proof). Its run surfaced the two findings below. They are independent of that design and apply to any restricted runtime role or broker.

## Finding 1 — Row-level security does not stop a tenant referencing another tenant's rows (VERIFIED)
Foreign-key checks are performed as the referenced table's owner and bypass the caller's RLS. A login that is correctly confined to its own tenant by RLS and WITH CHECK can still write a row whose foreign key points at another tenant's row, when the foreign key is a single-column key that does not include `business_id`.

Reproduction (disposable PG18, 67 migrations; nonowner NOBYPASSRLS login; FORCE RLS plus own-tenant SELECT/INSERT policies on `branches` and `feedback`):
```
-- tenant B's branch is invisible to the login:
SELECT count(*) FROM branches WHERE id = '<B branch>';                      -- 0
-- but a feedback row of tenant A may reference it, and tenant B's QR code:
INSERT INTO feedback(business_id, branch_id, qr_code_id, rating, comment)
VALUES ('<A>', '<B branch>', '<B qr>', 5, 'r20');                           -- INSERT 0 1 (ACCEPTED)
```
Inventory (read-only catalog query on the migrated schema): **37 single-column foreign keys between tables that both carry `business_id`** do not include it, against **19** composite keys that already do. They are candidates, not all confirmed defects: some are platform or global parents (for example roles), and some tables have their own guards (the signed-evidence events table has a tenant trigger; the partner-credit tables have their own financial guards). Each needs per-table review.

| Referencing table | Referenced table | FK column(s) |
|---|---|---|
| ai_usage_log | branches | branch_id |
| billing_partner_credit_applications | business_subscriptions | subscription_id |
| billing_partner_credit_applications | partner_credit_reservations | reservation_id |
| community_point_transactions | branches | branch_id |
| community_point_transactions | community_point_transactions | reversal_of |
| critical_incidents | branches | branch_id |
| critical_incidents | feedback | feedback_id |
| feedback | branches | branch_id |
| feedback | qr_codes | qr_code_id |
| feedback_summaries | branches | branch_id |
| fraud_signals | branches | branch_id |
| fraud_signals | feedback | feedback_id |
| loyalty_accounts | business_customer_memberships | membership_id |
| loyalty_accounts | loyalty_tiers | tier_id |
| loyalty_purchase_events | branches | branch_id |
| loyalty_purchase_events | business_customer_memberships | membership_id |
| loyalty_purchase_events | loyalty_accounts | loyalty_account_id |
| loyalty_rewards | branches | branch_id |
| partner_credit_multiunit_lot_allocations | partner_credit_accounts | account_id |
| partner_credit_multiunit_lot_allocations | partner_credit_award_decisions | decision_id |
| partner_credit_reservations | partner_credit_accounts | account_id |
| partner_credit_reservations | partner_credit_award_decisions | decision_id |
| qr_codes | branches | branch_id |
| qr_scan_events | branches | branch_id |
| qr_scan_events | qr_codes | qr_code_id |
| signed_evidence_events | signed_evidence_records | evidence_id |
| survey_campaigns | branches | branch_id |
| survey_campaigns | surveys | survey_id |
| survey_participations | branches | branch_id |
| survey_participations | consent_grants | consent_grant_id |
| survey_participations | survey_campaigns | campaign_id |
| survey_participations | surveys | survey_id |
| team_invitations | branches | branch_id |
| team_invitations | roles | role_id |
| user_business_roles | branches | branch_id |
| user_business_roles | roles | role_id |
| visit_sessions | branches | branch_id |

Consequences for the broker design: (1) an RLS policy or claim check alone does not establish that referenced identifiers belong to the caller's tenant; (2) every broker operation that accepts an identifier must verify its tenant explicitly inside the routine, or the database must enforce it; (3) leaks are possible through the reference, not only through reads (a later join or cascade can expose or mix data).

Direction (NOT implemented here): per table, add `UNIQUE (business_id, id)` on the parent and a composite foreign key on the child, introduced as separate reviewed migrations with a read-only pre-check that counts existing violating rows in staging and production first. Existing rows are unverified; do not assume the data is clean.

## Finding 2 — An invoker-rights trigger on `feedback` blocks a restricted login (VERIFIED)
`feedback_apply_response_allowance` runs `echo_grid_apply_response_allowance()` with invoker rights. It reads `business_subscriptions`, `subscription_plans` and `feedback`. A restricted login that has INSERT on `feedback` but, correctly, no access to subscription tables fails:
```
ERROR:  permission denied for table business_subscriptions
CONTEXT:  SQL statement "SELECT (sp.features ->> 'monthlyResponses')::integer ..."
```
Running it with definer rights and a fixed `search_path` (applied only inside the disposable database) lets the insert proceed and the entitlement logic still counts the caller's own tenant. A runtime role therefore needs this function hardened by a reviewed migration.

Inventory (heuristic: invoker-rights trigger functions whose source reads or writes tables; a hit is a prompt to review, not a defect):

| Table | Trigger function |
|---|---|
| business_subscriptions | echo_grid_unlock_queued_feedback |
| feedback | echo_grid_apply_response_allowance |
| heta_provenance_comparisons | heta_provenance_comparisons_check |
| heta_record_revisions | heta_record_revisions_chain |
| partner_credit_ledger | partner_credit_ledger_d4_evidence |
| partner_credit_ledger | partner_credit_ledger_r10_evidence |
| partner_credit_lots | partner_credit_lot_consume_transition |
| partner_credit_policies | partner_credit_policy_economics_immutable |
| partner_credit_recovery_obligations | partner_credit_obligation_conservation |
| partner_credit_reservations | partner_credit_reservation_consume_evidence |
| stripe_read_authorization_policy | stripe_read_policy_row_before |

The financial and evidence guard triggers in this list are intentionally strict and are **not** to be converted to definer rights without their own reviewed block. Only the entitlement and queue triggers on `feedback` and `business_subscriptions` are plausible near-term candidates.

## Not established
- Whether any existing production or staging row already violates tenant consistency (not queried; no live access used).
- Which of the 37 foreign keys are real exposure paths (per-table review needed).
- The behavior of the other 10 listed trigger functions under a restricted login.

## Restrictions
No migration, deployment, live database access, Hyperdrive or credential change, merge, or financial activation. Financial activation remains NO-GO.
