-- Closes the last replica-role TRUNCATE gap left by 0054: the two 0052 allocation tables. ADDITIVE, INERT, development only; nothing existing is changed.
--
-- 0052 guards s08_allocation_freezes and s08_allocation_freeze_items with ONE statement trigger each (BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE), enabled ORIGIN.
-- An ORIGIN trigger is skipped when a session sets session_replication_role = replica, so TRUNCATE succeeded there. 0054 could not simply flip those triggers to ENABLE
-- ALWAYS: they also guard INSERT/UPDATE/DELETE, and the disposable fixtures (D4 consumption tests, allocation-freeze tests) forge allocation rows on a replica-role connection
-- on purpose. The 0052 triggers are therefore left exactly as they are, and a SEPARATE truncate-only trigger, ENABLE ALWAYS, is added beside each, reusing the 0054 function
-- (public.financial_evidence_deny_truncate()). The new trigger names sort after the 0052 ones (trigger firing order is alphabetical), so a normal session still raises the
-- existing S08_ALLOCATION_INERT message first; only a replica-role TRUNCATE reaches the new trigger. Plain CREATE TRIGGER: a database that already has either name fails
-- the migration (one transaction) and nothing is left behind.
CREATE TRIGGER s08_allocation_parent_truncate_always BEFORE TRUNCATE ON public.s08_allocation_freezes FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.s08_allocation_freezes ENABLE ALWAYS TRIGGER s08_allocation_parent_truncate_always;--> statement-breakpoint
CREATE TRIGGER s08_allocation_child_truncate_always BEFORE TRUNCATE ON public.s08_allocation_freeze_items FOR EACH STATEMENT EXECUTE FUNCTION public.financial_evidence_deny_truncate();--> statement-breakpoint
ALTER TABLE public.s08_allocation_freeze_items ENABLE ALWAYS TRIGGER s08_allocation_child_truncate_always;
