-- Split 08 provider reconciliation attempts (additive, forward-only, INERT). Depends on 0048. 0040-0048 and every existing guard are untouched.
-- Write-denied like the other saga tables (reuses benefit_saga_inert_guard). An attempt row may be completed exactly once, then never changed;
-- rows are never deleted or truncated. Only an isolated disposable database may disable the inert guard.
CREATE TABLE "benefit_reconciliation_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"reconcile_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text,
	"detail_code" text,
	"http_status" integer,
	"retry_after_ms" integer,
	"next_retry_at" timestamp with time zone,
	"lines_inspected" integer,
	"effect_count" integer,
	CONSTRAINT "benefit_reconciliation_attempts_reconcile_key_unique" UNIQUE("reconcile_key"),
	CONSTRAINT "benefit_reconciliation_attempts_intent_no_key" UNIQUE("intent_id","attempt_no"),
	CONSTRAINT "benefit_reconciliation_attempts_no_check" CHECK ("benefit_reconciliation_attempts"."attempt_no" >= 1),
	CONSTRAINT "benefit_reconciliation_attempts_outcome_check" CHECK ("benefit_reconciliation_attempts"."outcome" IS NULL OR "benefit_reconciliation_attempts"."outcome" IN ('effect_present','absent_complete','incomplete','scope_mismatch','error_retryable','error_rate_limited','error_permanent')),
	CONSTRAINT "benefit_reconciliation_attempts_finished_check" CHECK (("benefit_reconciliation_attempts"."outcome" IS NULL) = ("benefit_reconciliation_attempts"."finished_at" IS NULL)),
	CONSTRAINT "benefit_reconciliation_attempts_counts_check" CHECK (("benefit_reconciliation_attempts"."lines_inspected" IS NULL OR "benefit_reconciliation_attempts"."lines_inspected" >= 0) AND ("benefit_reconciliation_attempts"."effect_count" IS NULL OR "benefit_reconciliation_attempts"."effect_count" >= 0) AND ("benefit_reconciliation_attempts"."retry_after_ms" IS NULL OR "benefit_reconciliation_attempts"."retry_after_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "benefit_reconciliation_attempts" ADD CONSTRAINT "benefit_reconciliation_attempts_intent_business_fk" FOREIGN KEY ("intent_id","business_id") REFERENCES "public"."benefit_application_intents"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "benefit_reconciliation_attempts_intent_idx" ON "benefit_reconciliation_attempts" USING btree ("intent_id","attempt_no");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION benefit_reconciliation_update_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Split 08 reconciliation attempts are append-only (delete refused)';
 END IF;
 IF OLD.outcome IS NOT NULL THEN
  RAISE EXCEPTION 'Split 08 reconciliation attempt already completed';
 END IF;
 IF NEW.id <> OLD.id OR NEW.intent_id <> OLD.intent_id OR NEW.business_id <> OLD.business_id OR NEW.attempt_no <> OLD.attempt_no
    OR NEW.reconcile_key <> OLD.reconcile_key OR NEW.started_at <> OLD.started_at THEN
  RAISE EXCEPTION 'Split 08 reconciliation attempt identity is immutable';
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER benefit_reconciliation_attempts_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON benefit_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION benefit_saga_inert_guard();
--> statement-breakpoint
CREATE TRIGGER benefit_reconciliation_attempts_update_once BEFORE UPDATE OR DELETE ON benefit_reconciliation_attempts FOR EACH ROW EXECUTE FUNCTION benefit_reconciliation_update_once();
--> statement-breakpoint
CREATE TRIGGER benefit_reconciliation_attempts_no_truncate BEFORE TRUNCATE ON benefit_reconciliation_attempts FOR EACH STATEMENT EXECUTE FUNCTION benefit_saga_append_only();
