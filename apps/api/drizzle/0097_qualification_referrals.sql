CREATE TABLE "customer_referral_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"event_type" text NOT NULL,
	"reason_code" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rule_version_id" uuid,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_referral_events_seq_uq" UNIQUE("referral_id","seq"),
	CONSTRAINT "customer_referral_events_type_valid" CHECK ("customer_referral_events"."event_type" IN ('attributed','pending_qualification','verified','expired','rejected','invalidated','revoked','fraud_review')),
	CONSTRAINT "customer_referral_events_seq_positive" CHECK ("customer_referral_events"."seq" >= 1),
	CONSTRAINT "customer_referral_events_verified_has_rule" CHECK ("customer_referral_events"."event_type" <> 'verified' OR "customer_referral_events"."rule_version_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "customer_referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_type" text NOT NULL,
	"referring_customer_id" uuid,
	"referred_customer_id" uuid NOT NULL,
	"business_id" uuid,
	"provenance_kind" text NOT NULL,
	"provenance_ref" text NOT NULL,
	"attributed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_referrals_type_valid" CHECK ("customer_referrals"."referral_type" IN ('business_invitation','customer_referral')),
	CONSTRAINT "customer_referrals_provenance_valid" CHECK ("customer_referrals"."provenance_kind" IN ('owner_invitation','cashier_assisted_invitation','customer_referral_token')),
	CONSTRAINT "customer_referrals_no_self" CHECK ("customer_referrals"."referring_customer_id" IS NULL OR "customer_referrals"."referring_customer_id" <> "customer_referrals"."referred_customer_id"),
	CONSTRAINT "customer_referrals_shape" CHECK (("customer_referrals"."referral_type" = 'business_invitation' AND "customer_referrals"."referring_customer_id" IS NULL AND "customer_referrals"."business_id" IS NOT NULL AND "customer_referrals"."provenance_kind" IN ('owner_invitation','cashier_assisted_invitation')) OR ("customer_referrals"."referral_type" = 'customer_referral' AND "customer_referrals"."referring_customer_id" IS NOT NULL AND "customer_referrals"."provenance_kind" = 'customer_referral_token'))
);
--> statement-breakpoint
CREATE TABLE "qualification_evidence_consumptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"evidence_kind" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"rule_version_id" uuid NOT NULL,
	"consumer_kind" text NOT NULL,
	"consumer_ref" text NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qualification_consumptions_kind_valid" CHECK ("qualification_evidence_consumptions"."evidence_kind" IN ('purchase_event','referral','badge_award') AND "qualification_evidence_consumptions"."consumer_kind" IN ('referral','badge','campaign'))
);
--> statement-breakpoint
CREATE TABLE "qualification_rule_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_key" text NOT NULL,
	"version" integer NOT NULL,
	"participant_type" text NOT NULL,
	"spec" jsonb NOT NULL,
	"spec_hash" text NOT NULL,
	"approval_state" text DEFAULT 'draft' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" uuid,
	"retired_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "qualification_rule_versions_key_version_uq" UNIQUE("rule_key","version"),
	CONSTRAINT "qualification_rule_versions_key_format" CHECK ("qualification_rule_versions"."rule_key" ~ '^[a-z][a-z0-9_]{2,63}$'),
	CONSTRAINT "qualification_rule_versions_participant_valid" CHECK ("qualification_rule_versions"."participant_type" IN ('customer','business')),
	CONSTRAINT "qualification_rule_versions_state_valid" CHECK ("qualification_rule_versions"."approval_state" IN ('draft','approved','retired')),
	CONSTRAINT "qualification_rule_versions_version_positive" CHECK ("qualification_rule_versions"."version" >= 1),
	CONSTRAINT "qualification_rule_versions_hash_format" CHECK ("qualification_rule_versions"."spec_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "qualification_rule_versions_approval_shape" CHECK (("qualification_rule_versions"."approval_state" = 'draft' AND "qualification_rule_versions"."approved_at" IS NULL AND "qualification_rule_versions"."retired_at" IS NULL) OR ("qualification_rule_versions"."approval_state" = 'approved' AND "qualification_rule_versions"."approved_at" IS NOT NULL AND "qualification_rule_versions"."approved_by_user_id" IS NOT NULL AND "qualification_rule_versions"."retired_at" IS NULL) OR ("qualification_rule_versions"."approval_state" = 'retired' AND "qualification_rule_versions"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "customer_referral_events" ADD CONSTRAINT "customer_referral_events_referral_id_customer_referrals_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."customer_referrals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referral_events" ADD CONSTRAINT "customer_referral_events_rule_version_id_qualification_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."qualification_rule_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referral_events" ADD CONSTRAINT "customer_referral_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_referring_customer_id_customers_id_fk" FOREIGN KEY ("referring_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_referred_customer_id_customers_id_fk" FOREIGN KEY ("referred_customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_referrals" ADD CONSTRAINT "customer_referrals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_evidence_consumptions" ADD CONSTRAINT "qualification_evidence_consumptions_rule_version_id_qualification_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."qualification_rule_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_rule_versions" ADD CONSTRAINT "qualification_rule_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qualification_rule_versions" ADD CONSTRAINT "qualification_rule_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referral_events_one_verified_uq" ON "customer_referral_events" USING btree ("referral_id") WHERE "customer_referral_events"."event_type" = 'verified';--> statement-breakpoint
CREATE INDEX "customer_referral_events_referral_idx" ON "customer_referral_events" USING btree ("referral_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referrals_referred_once_uq" ON "customer_referrals" USING btree ("referred_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_referrals_provenance_uq" ON "customer_referrals" USING btree ("provenance_kind","provenance_ref");--> statement-breakpoint
CREATE INDEX "customer_referrals_referrer_idx" ON "customer_referrals" USING btree ("referring_customer_id");--> statement-breakpoint
CREATE INDEX "customer_referrals_business_idx" ON "customer_referrals" USING btree ("business_id","attributed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_consumptions_once_uq" ON "qualification_evidence_consumptions" USING btree ("evidence_kind","evidence_id","rule_version_id","consumer_kind");--> statement-breakpoint
CREATE INDEX "qualification_consumptions_consumer_idx" ON "qualification_evidence_consumptions" USING btree ("consumer_kind","consumer_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "qualification_rule_versions_one_approved_idx" ON "qualification_rule_versions" USING btree ("rule_key") WHERE "qualification_rule_versions"."approval_state" = 'approved';
--> statement-breakpoint
-- TSH-02 / QUAL-PURCHASE-01 guards.
-- Rule versions: content immutable; INSERT is draft; the only moves are draft -> approved (stamps approved_at/by) and draft|approved -> retired.
CREATE OR REPLACE FUNCTION qualification_rule_versions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.approval_state = 'draft' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.id = OLD.id AND NEW.rule_key = OLD.rule_key AND NEW.version = OLD.version AND NEW.participant_type = OLD.participant_type
     AND NEW.spec = OLD.spec AND NEW.spec_hash = OLD.spec_hash AND NEW.created_by_user_id = OLD.created_by_user_id AND NEW.created_at = OLD.created_at
     AND ((OLD.approval_state = 'draft' AND NEW.approval_state IN ('approved','retired'))
          OR (OLD.approval_state = 'approved' AND NEW.approval_state = 'retired' AND NEW.approved_at = OLD.approved_at AND NEW.approved_by_user_id = OLD.approved_by_user_id)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'QUALIFICATION_RULE_VERSION_IMMUTABLE (%)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION qualification_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'QUALIFICATION_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
-- Referral events: the first event is `attributed` (seq 1); every later event extends the chain by exactly one and must be an ALLOWED transition from
-- the previous event. `verified` additionally requires an APPROVED customer rule version: with none approved, no referral can ever be verified.
CREATE OR REPLACE FUNCTION customer_referral_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  prev_seq integer;
  prev_type text;
  rule_ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'QUALIFICATION_LEDGER_APPEND_ONLY (% on customer_referral_events)', TG_OP USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  SELECT seq, event_type INTO prev_seq, prev_type FROM customer_referral_events WHERE referral_id = NEW.referral_id ORDER BY seq DESC LIMIT 1;
  IF prev_seq IS NULL THEN
    IF NEW.seq <> 1 OR NEW.event_type <> 'attributed' THEN
      RAISE EXCEPTION 'REFERRAL_FIRST_EVENT_MUST_BE_ATTRIBUTED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.seq <> prev_seq + 1 THEN
    RAISE EXCEPTION 'REFERRAL_EVENT_SEQUENCE_GAP' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT (
       (prev_type = 'attributed' AND NEW.event_type IN ('pending_qualification','expired','rejected','invalidated','revoked','fraud_review'))
    OR (prev_type = 'pending_qualification' AND NEW.event_type IN ('verified','expired','rejected','invalidated','revoked','fraud_review'))
    OR (prev_type = 'fraud_review' AND NEW.event_type IN ('pending_qualification','rejected','invalidated'))
    OR (prev_type = 'verified' AND NEW.event_type IN ('revoked','invalidated') AND NEW.actor_user_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'REFERRAL_TRANSITION_NOT_ALLOWED (% -> %)', prev_type, NEW.event_type USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.event_type = 'verified' THEN
    SELECT EXISTS (SELECT 1 FROM qualification_rule_versions r WHERE r.id = NEW.rule_version_id AND r.approval_state = 'approved' AND r.participant_type = 'customer') INTO rule_ok;
    IF NOT rule_ok THEN
      RAISE EXCEPTION 'REFERRAL_VERIFICATION_REQUIRES_APPROVED_RULE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER qualification_rule_versions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON qualification_rule_versions FOR EACH ROW EXECUTE FUNCTION qualification_rule_versions_guard();
--> statement-breakpoint
CREATE TRIGGER qualification_consumptions_append_only_trg BEFORE UPDATE OR DELETE ON qualification_evidence_consumptions FOR EACH ROW EXECUTE FUNCTION qualification_append_only();
--> statement-breakpoint
CREATE TRIGGER customer_referrals_append_only_trg BEFORE UPDATE OR DELETE ON customer_referrals FOR EACH ROW EXECUTE FUNCTION qualification_append_only();
--> statement-breakpoint
CREATE TRIGGER customer_referral_events_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON customer_referral_events FOR EACH ROW EXECUTE FUNCTION customer_referral_events_guard();
--> statement-breakpoint
CREATE TRIGGER qualification_rule_versions_no_truncate BEFORE TRUNCATE ON qualification_rule_versions FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER qualification_consumptions_no_truncate BEFORE TRUNCATE ON qualification_evidence_consumptions FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER customer_referrals_no_truncate BEFORE TRUNCATE ON customer_referrals FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER customer_referral_events_no_truncate BEFORE TRUNCATE ON customer_referral_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE qualification_rule_versions ENABLE ALWAYS TRIGGER qualification_rule_versions_guard_trg;
--> statement-breakpoint
ALTER TABLE qualification_evidence_consumptions ENABLE ALWAYS TRIGGER qualification_consumptions_append_only_trg;
--> statement-breakpoint
ALTER TABLE customer_referrals ENABLE ALWAYS TRIGGER customer_referrals_append_only_trg;
--> statement-breakpoint
ALTER TABLE customer_referral_events ENABLE ALWAYS TRIGGER customer_referral_events_guard_trg;
--> statement-breakpoint
ALTER TABLE qualification_rule_versions ENABLE ALWAYS TRIGGER qualification_rule_versions_no_truncate;
--> statement-breakpoint
ALTER TABLE qualification_evidence_consumptions ENABLE ALWAYS TRIGGER qualification_consumptions_no_truncate;
--> statement-breakpoint
ALTER TABLE customer_referrals ENABLE ALWAYS TRIGGER customer_referrals_no_truncate;
--> statement-breakpoint
ALTER TABLE customer_referral_events ENABLE ALWAYS TRIGGER customer_referral_events_no_truncate;
