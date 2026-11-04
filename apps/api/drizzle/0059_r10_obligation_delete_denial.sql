-- R10 Block 1 hardening (LOW-C). ADDITIVE, INERT, development only; no row, column, constraint or existing trigger is changed and nothing is activated.
--
-- Why: partner_credit_recovery_obligations carried an INSERT guard (0041/0042), a TRUNCATE denial (0054) and, since 0058, an UPDATE conservation guard, but nothing
-- denied a row DELETE. A deleted obligation silently erases recovery debt and orphans its recovery_offset / recovery_restored ledger evidence. The projection audit would
-- flag the mismatch afterwards; this migration refuses the write itself.
--
-- The denial is unconditional: nothing legitimate deletes an obligation (the only writers are the compensator's insert and the guarded units_outstanding update of the
-- vest offset and the R10 restoration; the account foreign key is ON DELETE RESTRICT, so no cascade reaches this table). The trigger is ENABLE ALWAYS, so it also fires
-- when a session sets session_replication_role = replica. It does NOT bind a superuser or the table owner, who can still DISABLE a trigger; restricting that is role
-- hardening, a separate block. It is not a privilege model: it denies the statement for every role that holds the DELETE privilege.
CREATE FUNCTION public.partner_credit_obligation_deny_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'PARTNER_CREDIT_OBLIGATION_DELETE_DENIED (%)', TG_TABLE_NAME;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.partner_credit_obligation_deny_delete() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER partner_credit_recovery_obligations_no_delete BEFORE DELETE ON public.partner_credit_recovery_obligations FOR EACH ROW EXECUTE FUNCTION public.partner_credit_obligation_deny_delete();--> statement-breakpoint
ALTER TABLE public.partner_credit_recovery_obligations ENABLE ALWAYS TRIGGER partner_credit_recovery_obligations_no_delete;
