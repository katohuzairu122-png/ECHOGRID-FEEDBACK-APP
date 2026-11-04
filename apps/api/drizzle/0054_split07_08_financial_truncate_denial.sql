-- TRUNCATE denial for the frozen Split 07 / Split 08 financial evidence tables. ADDITIVE, INERT, development only; no row, column, constraint or existing
-- trigger is changed and nothing is activated.
--
-- Why: the write guards from 0041/0042/0043/0047/0048 are FOR EACH ROW triggers on INSERT/UPDATE/DELETE. PostgreSQL does not fire row-level triggers for TRUNCATE,
-- so TRUNCATE (including `TRUNCATE businesses CASCADE`) could erase these tables, the Partner Credit ledger among them, past every guard. A catalog query on a
-- freshly migrated database found twelve Split 07/08 financial tables (the eleven below plus the frozen policy table) with no BEFORE TRUNCATE trigger; the other append-only
-- evidence tables (0045, 0048, 0049, 0050, 0051, 0052) already had one. This migration closes the remaining gap with the same pattern, and also makes the earlier
-- truncate-only triggers ENABLE ALWAYS (see the end of this file).
--
-- Each new trigger is ENABLE ALWAYS, so it also fires when a session sets session_replication_role = replica (which a plain ENABLE ORIGIN trigger ignores), and
-- therefore also blocks a replicated TRUNCATE. The denial is unconditional: there is no disposable-database exception, because nothing legitimate truncates
-- these tables (disposable databases are dropped, not truncated). A table owner or superuser can still DISABLE a trigger; restricting that is role hardening,
-- a separate block. Failure is atomic: a TRUNCATE ... CASCADE that reaches any of these tables fails as a whole and removes nothing.
CREATE FUNCTION public.financial_evidence_deny_truncate()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'FINANCIAL_EVIDENCE_TRUNCATE_DENIED (%)', TG_TABLE_NAME;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.financial_evidence_deny_truncate() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER benefit_application_intents_no_truncate BEFORE TRUNCATE ON public.benefit_application_intents FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.benefit_application_intents ENABLE ALWAYS TRIGGER benefit_application_intents_no_truncate;--> statement-breakpoint
CREATE TRIGGER billing_partner_credit_applications_no_truncate BEFORE TRUNCATE ON public.billing_partner_credit_applications FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.billing_partner_credit_applications ENABLE ALWAYS TRIGGER billing_partner_credit_applications_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_accounts_no_truncate BEFORE TRUNCATE ON public.partner_credit_accounts FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_accounts ENABLE ALWAYS TRIGGER partner_credit_accounts_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_award_decisions_no_truncate BEFORE TRUNCATE ON public.partner_credit_award_decisions FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_award_decisions ENABLE ALWAYS TRIGGER partner_credit_award_decisions_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_no_truncate BEFORE TRUNCATE ON public.partner_credit_ledger FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_ledger ENABLE ALWAYS TRIGGER partner_credit_ledger_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_lots_no_truncate BEFORE TRUNCATE ON public.partner_credit_lots FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_lots ENABLE ALWAYS TRIGGER partner_credit_lots_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_multiunit_lot_allocations_no_truncate BEFORE TRUNCATE ON public.partner_credit_multiunit_lot_allocations FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_multiunit_lot_allocations ENABLE ALWAYS TRIGGER partner_credit_multiunit_lot_allocations_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_multiunit_movements_no_truncate BEFORE TRUNCATE ON public.partner_credit_multiunit_movements FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_multiunit_movements ENABLE ALWAYS TRIGGER partner_credit_multiunit_movements_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_recovery_obligations_no_truncate BEFORE TRUNCATE ON public.partner_credit_recovery_obligations FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_recovery_obligations ENABLE ALWAYS TRIGGER partner_credit_recovery_obligations_no_truncate;--> statement-breakpoint
CREATE TRIGGER partner_credit_reservations_no_truncate BEFORE TRUNCATE ON public.partner_credit_reservations FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_reservations ENABLE ALWAYS TRIGGER partner_credit_reservations_no_truncate;--> statement-breakpoint
CREATE TRIGGER stripe_subscription_tier_observations_no_truncate BEFORE TRUNCATE ON public.stripe_subscription_tier_observations FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.stripe_subscription_tier_observations ENABLE ALWAYS TRIGGER stripe_subscription_tier_observations_no_truncate;
--> statement-breakpoint
CREATE TRIGGER partner_credit_policies_no_truncate BEFORE TRUNCATE ON public.partner_credit_policies FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.partner_credit_policies ENABLE ALWAYS TRIGGER partner_credit_policies_no_truncate;--> statement-breakpoint
-- The earlier truncate-only triggers (0045, 0048, 0049, 0050, 0051) are ENABLE ORIGIN and so were skipped under session_replication_role = replica. Their definitions
-- are untouched (those migrations are frozen); only their enablement changes. The 0052 statement triggers are deliberately NOT changed: they also guard INSERT/UPDATE/DELETE
-- and the disposable fixtures forge allocation rows on a replica-role connection.
ALTER TABLE public.benefit_application_compensations ENABLE ALWAYS TRIGGER benefit_application_compensations_no_truncate;--> statement-breakpoint
ALTER TABLE public.benefit_application_transitions ENABLE ALWAYS TRIGGER benefit_application_transitions_no_truncate;--> statement-breakpoint
ALTER TABLE public.benefit_provider_attempts ENABLE ALWAYS TRIGGER benefit_provider_attempts_no_truncate;--> statement-breakpoint
ALTER TABLE public.benefit_provider_observations ENABLE ALWAYS TRIGGER benefit_provider_observations_no_truncate;--> statement-breakpoint
ALTER TABLE public.benefit_reconciliation_attempts ENABLE ALWAYS TRIGGER benefit_reconciliation_attempts_no_truncate;--> statement-breakpoint
ALTER TABLE public.heta_provenance_comparisons ENABLE ALWAYS TRIGGER heta_provenance_comparisons_no_truncate;--> statement-breakpoint
ALTER TABLE public.heta_reconciliation_work ENABLE ALWAYS TRIGGER heta_reconciliation_work_no_truncate;--> statement-breakpoint
ALTER TABLE public.heta_record_revisions ENABLE ALWAYS TRIGGER heta_record_revisions_no_truncate;--> statement-breakpoint
ALTER TABLE public.partner_credit_award_disputes ENABLE ALWAYS TRIGGER partner_credit_award_disputes_no_truncate;--> statement-breakpoint
ALTER TABLE public.partner_credit_corrections ENABLE ALWAYS TRIGGER partner_credit_corrections_no_truncate;--> statement-breakpoint
ALTER TABLE public.partner_credit_dispute_events ENABLE ALWAYS TRIGGER partner_credit_dispute_events_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_evidence_control_events ENABLE ALWAYS TRIGGER stripe_evidence_control_events_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_evidence_keys ENABLE ALWAYS TRIGGER stripe_evidence_keys_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_provider_event_conflicts ENABLE ALWAYS TRIGGER stripe_provider_event_conflicts_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_provider_event_dispositions ENABLE ALWAYS TRIGGER stripe_provider_event_dispositions_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_provider_events ENABLE ALWAYS TRIGGER stripe_provider_events_no_truncate;--> statement-breakpoint
ALTER TABLE public.stripe_provider_malformed_receipts ENABLE ALWAYS TRIGGER stripe_provider_malformed_receipts_no_truncate;
