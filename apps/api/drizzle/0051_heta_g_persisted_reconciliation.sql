-- HETA Block G persisted foundations (additive, forward-only). 0040-0050 and every existing guard, trigger and evidence table are untouched.
-- heta_reconciliation_work: leased queue (done/dead are terminal, never deleted). heta_provenance_comparisons: immutable, identity-checked by trigger.
-- heta_record_revisions: append-only bitemporal chain; the database makes forks impossible and enforces the revocation/recovery rules.
-- Nothing here is written by the application yet; none of it attributes events to tenants or authorizes anything.
CREATE TABLE "heta_provenance_comparisons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_record_id" uuid NOT NULL,
	"retrieved_record_id" uuid,
	"disposition" text NOT NULL,
	"mismatches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rule_version" text NOT NULL,
	"compared_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "heta_provenance_comparisons_disposition_check" CHECK ("heta_provenance_comparisons"."disposition" IN ('corroborated_fields','conflicted','incomparable','unassessed')),
	CONSTRAINT "heta_provenance_comparisons_arrays_check" CHECK (jsonb_typeof("heta_provenance_comparisons"."mismatches") = 'array' AND jsonb_typeof("heta_provenance_comparisons"."reasons") = 'array'),
	CONSTRAINT "heta_provenance_comparisons_rule_check" CHECK (char_length("heta_provenance_comparisons"."rule_version") BETWEEN 1 AND 100),
	CONSTRAINT "heta_provenance_comparisons_shape_check" CHECK (("heta_provenance_comparisons"."disposition" = 'corroborated_fields' AND "heta_provenance_comparisons"."retrieved_record_id" IS NOT NULL AND jsonb_array_length("heta_provenance_comparisons"."mismatches") = 0 AND jsonb_array_length("heta_provenance_comparisons"."reasons") = 0)
    OR ("heta_provenance_comparisons"."disposition" = 'conflicted' AND "heta_provenance_comparisons"."retrieved_record_id" IS NOT NULL AND jsonb_array_length("heta_provenance_comparisons"."mismatches") > 0)
    OR ("heta_provenance_comparisons"."disposition" = 'incomparable' AND "heta_provenance_comparisons"."retrieved_record_id" IS NOT NULL AND jsonb_array_length("heta_provenance_comparisons"."reasons") > 0)
    OR ("heta_provenance_comparisons"."disposition" = 'unassessed' AND "heta_provenance_comparisons"."retrieved_record_id" IS NULL AND jsonb_array_length("heta_provenance_comparisons"."mismatches") = 0))
);
--> statement-breakpoint
CREATE TABLE "heta_reconciliation_work" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"lease_token" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"not_before" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "heta_reconciliation_work_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "heta_reconciliation_work_kind_check" CHECK ("heta_reconciliation_work"."kind" IN ('compare_provenance','retrieve_event','reconcile_window')),
	CONSTRAINT "heta_reconciliation_work_state_check" CHECK ("heta_reconciliation_work"."state" IN ('pending','leased','done','dead')),
	CONSTRAINT "heta_reconciliation_work_attempts_check" CHECK ("heta_reconciliation_work"."attempts" >= 0 AND "heta_reconciliation_work"."max_attempts" BETWEEN 1 AND 20 AND "heta_reconciliation_work"."attempts" <= "heta_reconciliation_work"."max_attempts"),
	CONSTRAINT "heta_reconciliation_work_payload_check" CHECK (jsonb_typeof("heta_reconciliation_work"."payload") = 'object' AND pg_column_size("heta_reconciliation_work"."payload") <= 4096),
	CONSTRAINT "heta_reconciliation_work_subject_check" CHECK (char_length("heta_reconciliation_work"."subject_key") BETWEEN 1 AND 300 AND char_length("heta_reconciliation_work"."dedupe_key") BETWEEN 1 AND 400),
	CONSTRAINT "heta_reconciliation_work_error_code_check" CHECK ("heta_reconciliation_work"."last_error_code" IS NULL OR "heta_reconciliation_work"."last_error_code" ~ '^[a-z0-9_]{1,64}$'),
	CONSTRAINT "heta_reconciliation_work_shape_check" CHECK (("heta_reconciliation_work"."state" = 'leased') = ("heta_reconciliation_work"."lease_token" IS NOT NULL AND "heta_reconciliation_work"."lease_owner" IS NOT NULL AND "heta_reconciliation_work"."lease_expires_at" IS NOT NULL)
    AND (("heta_reconciliation_work"."state" IN ('done','dead')) = ("heta_reconciliation_work"."completed_at" IS NOT NULL))
    AND ("heta_reconciliation_work"."state" <> 'dead' OR "heta_reconciliation_work"."last_error_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "heta_record_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_key" text NOT NULL,
	"revision" integer NOT NULL,
	"supersedes" uuid,
	"state" text NOT NULL,
	"effective_from" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"recovery_ref" text,
	"subject_ref" text,
	CONSTRAINT "heta_record_revisions_scope_revision_key" UNIQUE("scope_key","revision"),
	CONSTRAINT "heta_record_revisions_id_scope_key" UNIQUE("id","scope_key"),
	CONSTRAINT "heta_record_revisions_state_check" CHECK ("heta_record_revisions"."state" IN ('active','revoked','compromised')),
	CONSTRAINT "heta_record_revisions_first_check" CHECK (("heta_record_revisions"."revision" = 1) = ("heta_record_revisions"."supersedes" IS NULL) AND "heta_record_revisions"."revision" >= 1),
	CONSTRAINT "heta_record_revisions_scope_check" CHECK (char_length("heta_record_revisions"."scope_key") BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "heta_provenance_comparisons" ADD CONSTRAINT "heta_provenance_comparisons_webhook_record_id_stripe_provider_events_id_fk" FOREIGN KEY ("webhook_record_id") REFERENCES "public"."stripe_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heta_provenance_comparisons" ADD CONSTRAINT "heta_provenance_comparisons_retrieved_record_id_stripe_provider_events_id_fk" FOREIGN KEY ("retrieved_record_id") REFERENCES "public"."stripe_provider_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "heta_record_revisions" ADD CONSTRAINT "heta_record_revisions_supersedes_fk" FOREIGN KEY ("supersedes","scope_key") REFERENCES "public"."heta_record_revisions"("id","scope_key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "heta_provenance_comparisons_pair_uq" ON "heta_provenance_comparisons" USING btree ("webhook_record_id","retrieved_record_id","rule_version") WHERE "heta_provenance_comparisons"."retrieved_record_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "heta_provenance_comparisons_unassessed_uq" ON "heta_provenance_comparisons" USING btree ("webhook_record_id","rule_version") WHERE "heta_provenance_comparisons"."retrieved_record_id" IS NULL;--> statement-breakpoint
CREATE INDEX "heta_provenance_comparisons_webhook_idx" ON "heta_provenance_comparisons" USING btree ("webhook_record_id","compared_at");--> statement-breakpoint
CREATE INDEX "heta_reconciliation_work_claim_idx" ON "heta_reconciliation_work" USING btree ("state","not_before");--> statement-breakpoint
CREATE INDEX "heta_reconciliation_work_lease_idx" ON "heta_reconciliation_work" USING btree ("state","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "heta_record_revisions_successor_key" ON "heta_record_revisions" USING btree ("supersedes") WHERE "heta_record_revisions"."supersedes" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION heta_reconciliation_work_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'HETA reconciliation work is never deleted'; END IF;
 IF OLD.state IN ('done','dead') THEN RAISE EXCEPTION 'HETA reconciliation work in a terminal state cannot change'; END IF;
 IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.subject_key <> OLD.subject_key OR NEW.dedupe_key <> OLD.dedupe_key
    OR NEW.payload <> OLD.payload OR NEW.created_at <> OLD.created_at OR NEW.max_attempts <> OLD.max_attempts THEN
  RAISE EXCEPTION 'HETA reconciliation work identity is immutable';
 END IF;
 IF NEW.attempts < OLD.attempts THEN RAISE EXCEPTION 'HETA reconciliation work attempts never decrease'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION heta_g_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'HETA Block G records are append-only (%)', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION heta_provenance_comparisons_check()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE w stripe_provider_events%ROWTYPE; r stripe_provider_events%ROWTYPE;
BEGIN
 SELECT * INTO w FROM stripe_provider_events WHERE id = NEW.webhook_record_id;
 IF NOT FOUND OR w.provenance <> 'webhook_signature' THEN RAISE EXCEPTION 'HETA comparison: webhook side must be a webhook_signature receipt'; END IF;
 IF NEW.retrieved_record_id IS NOT NULL THEN
  SELECT * INTO r FROM stripe_provider_events WHERE id = NEW.retrieved_record_id;
  IF NOT FOUND OR r.provenance <> 'api_retrieval' THEN RAISE EXCEPTION 'HETA comparison: retrieved side must be an api_retrieval receipt'; END IF;
  IF r.receiving_account_id <> w.receiving_account_id OR r.event_account_id <> w.event_account_id OR r.livemode <> w.livemode OR r.stripe_event_id <> w.stripe_event_id THEN
   RAISE EXCEPTION 'HETA comparison: both receipts must carry the same canonical event identity';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION heta_record_revisions_chain()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prev heta_record_revisions%ROWTYPE; restricted timestamptz; flr timestamptz;
BEGIN
 IF NEW.supersedes IS NULL THEN
  RETURN NEW; -- revision 1: uniqueness of (scope_key, revision) and the first-revision CHECK govern it
 END IF;
 SELECT * INTO prev FROM heta_record_revisions WHERE id = NEW.supersedes AND scope_key = NEW.scope_key;
 IF NOT FOUND THEN RAISE EXCEPTION 'HETA revision: unknown predecessor in this scope'; END IF;
 IF NEW.revision <> prev.revision + 1 THEN RAISE EXCEPTION 'HETA revision: revisions must be monotonic'; END IF;
 IF NEW.recorded_at < prev.recorded_at THEN RAISE EXCEPTION 'HETA revision: recorded time cannot regress'; END IF;
 IF NEW.state = 'active' THEN
  IF prev.state <> 'active' AND (NEW.recovery_ref IS NULL OR btrim(NEW.recovery_ref) = '') THEN
   RAISE EXCEPTION 'HETA revision: leaving revoked or compromised requires a recovery reference';
  END IF;
  SELECT max(effective_from) INTO restricted FROM heta_record_revisions WHERE scope_key = NEW.scope_key AND state <> 'active';
  SELECT max(x.effective_from) INTO flr FROM heta_record_revisions x LEFT JOIN heta_record_revisions p ON p.id = x.supersedes
   WHERE x.scope_key = NEW.scope_key AND (x.state <> 'active' OR p.state <> 'active');
  IF prev.state <> 'active' AND restricted IS NOT NULL AND NEW.effective_from <= restricted THEN
   RAISE EXCEPTION 'HETA revision: a recovery must take effect after the restriction it ends';
  END IF;
  IF flr IS NOT NULL AND NEW.effective_from < flr THEN
   RAISE EXCEPTION 'HETA revision: a revoked or compromised period cannot be restored retroactively';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER heta_reconciliation_work_guard BEFORE UPDATE OR DELETE ON heta_reconciliation_work FOR EACH ROW EXECUTE FUNCTION heta_reconciliation_work_guard();
--> statement-breakpoint
CREATE TRIGGER heta_reconciliation_work_no_truncate BEFORE TRUNCATE ON heta_reconciliation_work FOR EACH STATEMENT EXECUTE FUNCTION heta_g_append_only();
--> statement-breakpoint
CREATE TRIGGER heta_provenance_comparisons_check BEFORE INSERT ON heta_provenance_comparisons FOR EACH ROW EXECUTE FUNCTION heta_provenance_comparisons_check();
--> statement-breakpoint
CREATE TRIGGER heta_provenance_comparisons_append_only BEFORE UPDATE OR DELETE ON heta_provenance_comparisons FOR EACH ROW EXECUTE FUNCTION heta_g_append_only();
--> statement-breakpoint
CREATE TRIGGER heta_provenance_comparisons_no_truncate BEFORE TRUNCATE ON heta_provenance_comparisons FOR EACH STATEMENT EXECUTE FUNCTION heta_g_append_only();
--> statement-breakpoint
CREATE TRIGGER heta_record_revisions_chain BEFORE INSERT ON heta_record_revisions FOR EACH ROW EXECUTE FUNCTION heta_record_revisions_chain();
--> statement-breakpoint
CREATE TRIGGER heta_record_revisions_append_only BEFORE UPDATE OR DELETE ON heta_record_revisions FOR EACH ROW EXECUTE FUNCTION heta_g_append_only();
--> statement-breakpoint
CREATE TRIGGER heta_record_revisions_no_truncate BEFORE TRUNCATE ON heta_record_revisions FOR EACH STATEMENT EXECUTE FUNCTION heta_g_append_only();
