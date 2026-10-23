-- Split 08 durable benefit-application saga (additive, forward-only, INERT). 0040-0047 and every existing guard are untouched.
-- Every table is write-denied like 0042's reservation/application tables; only an isolated disposable database may DISABLE the guard
-- triggers for tests. Four tables are additionally append-only (their UPDATE/DELETE/TRUNCATE are always refused, guard or not).
CREATE TABLE "benefit_application_compensations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"reversal_ref" text NOT NULL,
	"units" integer NOT NULL,
	"benefit_minor" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "benefit_application_compensations_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "benefit_application_compensations_negative_check" CHECK ("benefit_application_compensations"."units" < 0 AND "benefit_application_compensations"."benefit_minor" < 0)
);
--> statement-breakpoint
CREATE TABLE "benefit_application_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"invoice_ref" text NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"expected_benefit_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"policy_version" text NOT NULL,
	"state" text DEFAULT 'reserved' NOT NULL,
	"outcome" text DEFAULT 'pending' NOT NULL,
	"attempt_key" text,
	"attempted_at" timestamp with time zone,
	"cause" text,
	"pending_reversal_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_effect_ref" text,
	"applied_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "benefit_application_intents_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "benefit_application_intents_units_check" CHECK ("benefit_application_intents"."units" = 1),
	CONSTRAINT "benefit_application_intents_benefit_check" CHECK ("benefit_application_intents"."expected_benefit_minor" > 0),
	CONSTRAINT "benefit_application_intents_currency_check" CHECK ("benefit_application_intents"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "benefit_application_intents_state_check" CHECK ("benefit_application_intents"."state" IN ('reserved','applying','retained','consumed','released')),
	CONSTRAINT "benefit_application_intents_outcome_check" CHECK ("benefit_application_intents"."outcome" IN ('pending','confirmed','rejected','disputed','unresolved')),
	CONSTRAINT "benefit_application_intents_version_check" CHECK ("benefit_application_intents"."version" >= 1),
	CONSTRAINT "benefit_application_intents_pending_array_check" CHECK (jsonb_typeof("benefit_application_intents"."pending_reversal_refs") = 'array'),
	CONSTRAINT "benefit_application_intents_shape_check" CHECK ((
    ("benefit_application_intents"."state" = 'reserved' AND "benefit_application_intents"."attempt_key" IS NULL AND "benefit_application_intents"."cause" IS NULL AND "benefit_application_intents"."provider_effect_ref" IS NULL AND "benefit_application_intents"."applied_at" IS NULL AND "benefit_application_intents"."outcome" = 'pending')
    OR ("benefit_application_intents"."state" = 'applying' AND "benefit_application_intents"."attempt_key" IS NOT NULL AND "benefit_application_intents"."attempted_at" IS NOT NULL AND "benefit_application_intents"."cause" IS NULL AND "benefit_application_intents"."provider_effect_ref" IS NULL AND "benefit_application_intents"."applied_at" IS NULL AND "benefit_application_intents"."outcome" = 'pending')
    OR ("benefit_application_intents"."state" = 'retained' AND "benefit_application_intents"."attempt_key" IS NOT NULL AND "benefit_application_intents"."attempted_at" IS NOT NULL AND "benefit_application_intents"."cause" IS NOT NULL AND "benefit_application_intents"."provider_effect_ref" IS NULL AND "benefit_application_intents"."applied_at" IS NULL AND "benefit_application_intents"."outcome" IN ('disputed','unresolved'))
    OR ("benefit_application_intents"."state" = 'consumed' AND "benefit_application_intents"."attempt_key" IS NOT NULL AND "benefit_application_intents"."provider_effect_ref" IS NOT NULL AND "benefit_application_intents"."applied_at" IS NOT NULL AND "benefit_application_intents"."cause" IS NULL AND "benefit_application_intents"."outcome" = 'confirmed')
    OR ("benefit_application_intents"."state" = 'released' AND "benefit_application_intents"."cause" IS NOT NULL AND "benefit_application_intents"."provider_effect_ref" IS NULL AND "benefit_application_intents"."applied_at" IS NULL AND "benefit_application_intents"."outcome" = 'rejected')))
);
--> statement-breakpoint
CREATE TABLE "benefit_application_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "benefit_application_transitions_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"intent_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"replay" boolean NOT NULL,
	"attempt_key" text,
	"effects" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "benefit_application_transitions_event_check" CHECK ("benefit_application_transitions"."event_type" IN ('begin_apply','provider_observation','reverse','release_unused')),
	CONSTRAINT "benefit_application_transitions_effects_check" CHECK (jsonb_typeof("benefit_application_transitions"."effects") = 'array')
);
--> statement-breakpoint
CREATE TABLE "benefit_provider_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"attempt_key" text NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "benefit_provider_attempts_provider_idempotency_key_unique" UNIQUE("provider_idempotency_key"),
	CONSTRAINT "benefit_provider_attempts_intent_attempt_key" UNIQUE("intent_id","attempt_key")
);
--> statement-breakpoint
CREATE TABLE "benefit_provider_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"intent_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"attempt_key" text NOT NULL,
	"status" text NOT NULL,
	"classification" text NOT NULL,
	"effect_ref" text,
	"amount_minor" integer,
	"currency" text,
	"invoice_ref" text,
	"attributed_reservation_ref" text,
	"checked_at" timestamp with time zone NOT NULL,
	"payload_digest" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "benefit_provider_observations_status_check" CHECK ("benefit_provider_observations"."status" IN ('effect_present','effect_absent','unreachable')),
	CONSTRAINT "benefit_provider_observations_class_check" CHECK ("benefit_provider_observations"."classification" IN ('matched','mismatch','unattributed','absent_confirmed','absent_stale','unreachable')),
	CONSTRAINT "benefit_provider_observations_digest_check" CHECK ("benefit_provider_observations"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "benefit_provider_observations_shape_check" CHECK (("benefit_provider_observations"."status" = 'effect_present' AND "benefit_provider_observations"."effect_ref" IS NOT NULL AND "benefit_provider_observations"."amount_minor" IS NOT NULL AND "benefit_provider_observations"."amount_minor" >= 0 AND "benefit_provider_observations"."currency" IS NOT NULL AND "benefit_provider_observations"."invoice_ref" IS NOT NULL AND "benefit_provider_observations"."classification" IN ('matched','mismatch','unattributed'))
    OR ("benefit_provider_observations"."status" = 'effect_absent' AND "benefit_provider_observations"."effect_ref" IS NULL AND "benefit_provider_observations"."classification" IN ('absent_confirmed','absent_stale'))
    OR ("benefit_provider_observations"."status" = 'unreachable' AND "benefit_provider_observations"."effect_ref" IS NULL AND "benefit_provider_observations"."classification" = 'unreachable'))
);
--> statement-breakpoint
ALTER TABLE "benefit_application_compensations" ADD CONSTRAINT "benefit_application_compensations_intent_business_fk" FOREIGN KEY ("intent_id","business_id") REFERENCES "public"."benefit_application_intents"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_application_intents" ADD CONSTRAINT "benefit_application_intents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_application_intents" ADD CONSTRAINT "benefit_application_intents_reservation_business_fk" FOREIGN KEY ("reservation_id","business_id") REFERENCES "public"."partner_credit_reservations"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_application_transitions" ADD CONSTRAINT "benefit_application_transitions_intent_business_fk" FOREIGN KEY ("intent_id","business_id") REFERENCES "public"."benefit_application_intents"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_provider_attempts" ADD CONSTRAINT "benefit_provider_attempts_intent_business_fk" FOREIGN KEY ("intent_id","business_id") REFERENCES "public"."benefit_application_intents"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benefit_provider_observations" ADD CONSTRAINT "benefit_provider_observations_intent_business_fk" FOREIGN KEY ("intent_id","business_id") REFERENCES "public"."benefit_application_intents"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_application_compensations_reversal_key" ON "benefit_application_compensations" USING btree ("intent_id","reversal_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_application_intents_reservation_key" ON "benefit_application_intents" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_application_intents_effect_key" ON "benefit_application_intents" USING btree ("provider_effect_ref") WHERE "benefit_application_intents"."provider_effect_ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "benefit_application_intents_state_idx" ON "benefit_application_intents" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "benefit_application_transitions_intent_seq_idx" ON "benefit_application_transitions" USING btree ("intent_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_provider_attempts_intent_key" ON "benefit_provider_attempts" USING btree ("intent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "benefit_provider_observations_digest_key" ON "benefit_provider_observations" USING btree ("intent_id","attempt_key","payload_digest");--> statement-breakpoint
CREATE INDEX "benefit_provider_observations_intent_idx" ON "benefit_provider_observations" USING btree ("intent_id","recorded_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION benefit_saga_inert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Split 08 benefit-application saga writes disabled pending financial activation authorization';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION benefit_saga_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Split 08 benefit-application saga evidence is append-only (%)', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER benefit_application_intents_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON benefit_application_intents FOR EACH ROW EXECUTE FUNCTION benefit_saga_inert_guard();
--> statement-breakpoint
CREATE TRIGGER benefit_provider_attempts_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON benefit_provider_attempts FOR EACH ROW EXECUTE FUNCTION benefit_saga_inert_guard();
--> statement-breakpoint
CREATE TRIGGER benefit_provider_observations_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON benefit_provider_observations FOR EACH ROW EXECUTE FUNCTION benefit_saga_inert_guard();
--> statement-breakpoint
CREATE TRIGGER benefit_application_compensations_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON benefit_application_compensations FOR EACH ROW EXECUTE FUNCTION benefit_saga_inert_guard();
--> statement-breakpoint
CREATE TRIGGER benefit_application_transitions_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON benefit_application_transitions FOR EACH ROW EXECUTE FUNCTION benefit_saga_inert_guard();
--> statement-breakpoint
CREATE TRIGGER benefit_provider_attempts_append_only BEFORE UPDATE OR DELETE ON benefit_provider_attempts FOR EACH ROW EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_provider_observations_append_only BEFORE UPDATE OR DELETE ON benefit_provider_observations FOR EACH ROW EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_application_compensations_append_only BEFORE UPDATE OR DELETE ON benefit_application_compensations FOR EACH ROW EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_application_transitions_append_only BEFORE UPDATE OR DELETE ON benefit_application_transitions FOR EACH ROW EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_provider_attempts_no_truncate BEFORE TRUNCATE ON benefit_provider_attempts FOR EACH STATEMENT EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_provider_observations_no_truncate BEFORE TRUNCATE ON benefit_provider_observations FOR EACH STATEMENT EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_application_compensations_no_truncate BEFORE TRUNCATE ON benefit_application_compensations FOR EACH STATEMENT EXECUTE FUNCTION benefit_saga_append_only();
--> statement-breakpoint
CREATE TRIGGER benefit_application_transitions_no_truncate BEFORE TRUNCATE ON benefit_application_transitions FOR EACH STATEMENT EXECUTE FUNCTION benefit_saga_append_only();
