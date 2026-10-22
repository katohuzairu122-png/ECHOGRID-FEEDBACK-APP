# Split 08 CE-1 — database-enforced tenant integrity (migration 0047)

**Status: IMPLEMENTED, INERT. No economic activation.** Closes the gap recorded in `CE1_POSTGRES_PERSISTENCE_INTEGRITY_TEST_GATE.md` and `CE1_TENANT_PROVIDER_FINALIZATION_RACE_GATE.md`: individual foreign keys did not prove that a reservation or application row's tenant keys agree across its parents; only the read-side verifiers detected a mismatch.

Forward-only, additive; 0040–0046 are unchanged and the 0041/0042/0044 write denials are untouched (the reservation and application tables still refuse all writes in ordinary databases).

| Table | Composite foreign key | Guarantees |
|---|---|---|
| `partner_credit_reservations` | `(decision_id, business_id)` → award decisions `(id, business_id)` | decision belongs to the reservation's business |
| | `(account_id, business_id)` → accounts `(id, business_id)` | account belongs to the reservation's business |
| | `(lot_id, decision_id, account_id)` → lots `(id, decision_id, account_id)` | the lot belongs to exactly that decision and account |
| `billing_partner_credit_applications` | `(reservation_id, business_id)` → reservations `(id, business_id)` | application business equals the reservation's |
| | `(subscription_id, business_id)` → business subscriptions `(id, business_id)` | subscription belongs to the same business |

The parents gain `UNIQUE (id, …)` constraints as FK targets (created first; always satisfiable because `id` is already the primary key). The `ALTER TABLE ... ADD CONSTRAINT UNIQUE` statements briefly lock `business_subscriptions`, `partner_credit_accounts`, `partner_credit_award_decisions` and `partner_credit_lots` while their indexes build; apply in a quiet window through the separately authorized `migrate-production.yml`.

The read-side `Split08Ce1TenantIntegrityVerifier` and `PartnerCreditApplicationIntegrityReader` remain as defense in depth; their integration test now builds forged rows with `session_replication_role = replica` on a disposable connection only.

Not changed: provider verification, consumption, the unresolved economic policy (`INVOICE_BENEFIT_ECONOMICS_PROVIDER_RECONCILIATION_FREEZE_GATE.md`). A structurally consistent row is still not provider-verified consumption.
