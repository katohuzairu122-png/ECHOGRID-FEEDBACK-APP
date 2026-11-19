-- D2-R8 (CASHIER-PROD-D2-R8): database-enforced immutability of audit_log.
--
-- Before this migration audit_log was append-only by application convention only: no trigger, no REVOKE, and the runtime
-- principal (neondb_owner, the table owner) held UPDATE, DELETE and TRUNCATE. This migration adds the database guard. It does
-- NOT redact, rewrite or delete any existing row, does NOT change any privilege, and does NOT introduce any role.
--
-- What it stops: application bugs, SQL injection through ordinary DML, accidental maintenance statements, and any role that is
-- not the table owner. What it cannot stop (stated plainly): the table owner or a superuser can still DISABLE or DROP the trigger,
-- because PostgreSQL gives them that right. The production runtime login IS the owner (Hyperdrive origin user neondb_owner), so
-- this is a tripwire against defects and ordinary-DML abuse, not a defence against a compromised owner credential. A real
-- boundary needs a separate non-owner runtime role: an architecture change that is an Owner decision (see the R8 record).
--
-- Why REVOKE is not used: referential actions (businesses/users ON DELETE SET NULL) UPDATE audit_log AS ITS OWNER, so revoking
-- UPDATE from the owner would break business and user deletion, and the owner can re-grant it anyway.
--
-- The one permitted UPDATE: PostgreSQL's own ON DELETE SET NULL on business_id / actor_user_id. It is recognised by shape (only
-- those two columns change, each only from a value to NULL) AND by nesting (pg_trigger_depth() > 1: the referential-action
-- trigger is what issued it). A direct statement from a session runs at depth 1 and is refused even with the same shape.
-- Insert is untouched, so every audit writer keeps working. Corrections must be new rows.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_immutability_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND pg_trigger_depth() > 1
     AND (to_jsonb(NEW) - 'business_id' - 'actor_user_id') = (to_jsonb(OLD) - 'business_id' - 'actor_user_id')
     AND (NEW.business_id IS NOT DISTINCT FROM OLD.business_id OR (NEW.business_id IS NULL AND OLD.business_id IS NOT NULL))
     AND (NEW.actor_user_id IS NOT DISTINCT FROM OLD.actor_user_id OR (NEW.actor_user_id IS NULL AND OLD.actor_user_id IS NOT NULL))
     AND (NEW.business_id IS DISTINCT FROM OLD.business_id OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutability_guard_trg BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutability_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION audit_log_truncate_denied() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_TRUNCATE_DENIED' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_truncate_denied();
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_immutability_guard_trg;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate;
