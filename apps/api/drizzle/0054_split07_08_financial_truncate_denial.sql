-- TRUNCATE denial for the frozen Split 07 / Split 08 financial evidence tables. ADDITIVE, INERT, development only; no row, column, constraint or existing
-- trigger is changed and nothing is activated.
--
-- Why: the write guards from 0041/0042/0043/0047/0048 are FOR EACH ROW triggers on INSERT/UPDATE/DELETE. PostgreSQL does not fire row-level triggers for TRUNCATE,
-- so TRUNCATE (including `TRUNCATE businesses CASCADE`) could erase these tables, the Partner Credit ledger among them, past every guard. A catalog query on a
-- freshly migrated database found eleven guarded tables with no BEFORE TRUNCATE trigger; every other append-only evidence table (0045, 0048, 0049, 0050, 0051, 0052)
-- already had one. This migration closes the remaining gap with the same pattern.
--
-- Each trigger is ENABLE ALWAYS, so it also fires when a session sets session_replication_role = replica (which a plain ENABLE ORIGIN trigger ignores), and
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
