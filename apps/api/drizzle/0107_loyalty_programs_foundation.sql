CREATE TABLE "loyalty_program_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"program_version" integer NOT NULL,
	"loyalty_account_id" uuid NOT NULL,
	"reward_id" uuid NOT NULL,
	"source_key" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"earned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_by" uuid,
	CONSTRAINT "loyalty_program_entitlements_status_check" CHECK ("loyalty_program_entitlements"."status" IN ('available','redeemed','expired','reversed'))
);
--> statement-breakpoint
CREATE TABLE "loyalty_program_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"version" integer,
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_program_events_type_check" CHECK ("loyalty_program_events"."event_type" IN ('created','version_created','validated','activated','deactivated','retired','switched_to','switched_from','legacy_backfill'))
);
--> statement-breakpoint
CREATE TABLE "loyalty_program_progress" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"loyalty_account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"counters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_program_progress_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"progress_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"program_version" integer NOT NULL,
	"loyalty_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"delta" integer NOT NULL,
	"counters_after" jsonb NOT NULL,
	"purchase_event_id" uuid,
	"source_key" text NOT NULL,
	"reverses_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loyalty_program_setup" (
	"business_id" uuid PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_program_setup_state_check" CHECK ("loyalty_program_setup"."state" IN ('pending','configured'))
);
--> statement-breakpoint
CREATE TABLE "loyalty_program_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_program_versions_version_check" CHECK ("loyalty_program_versions"."version" >= 1),
	CONSTRAINT "loyalty_program_versions_config_object" CHECK (jsonb_typeof("loyalty_program_versions"."config") = 'object' AND pg_column_size("loyalty_program_versions"."config") <= 65536)
);
--> statement-breakpoint
CREATE TABLE "loyalty_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"legacy" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"activated_by" uuid,
	"activated_at" timestamp with time zone,
	"deactivated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "loyalty_programs_type_check" CHECK ("loyalty_programs"."type" IN ('LP-01','LP-02','LP-03','LP-04','LP-05','LP-06','LP-07','LP-08')),
	CONSTRAINT "loyalty_programs_status_check" CHECK ("loyalty_programs"."status" IN ('draft','validated','active','inactive','retired')),
	CONSTRAINT "loyalty_programs_version_check" CHECK ("loyalty_programs"."current_version" >= 1),
	CONSTRAINT "loyalty_programs_lp08_not_activatable" CHECK ("loyalty_programs"."status" <> 'active' OR "loyalty_programs"."type" <> 'LP-08')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_programs_id_business_uq" ON "loyalty_programs" USING btree ("id","business_id");
--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "program_id" uuid;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "program_version" integer;--> statement-breakpoint
ALTER TABLE "loyalty_program_entitlements" ADD CONSTRAINT "loyalty_program_entitlements_loyalty_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("loyalty_account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_entitlements" ADD CONSTRAINT "loyalty_program_entitlements_reward_id_loyalty_rewards_id_fk" FOREIGN KEY ("reward_id") REFERENCES "public"."loyalty_rewards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_entitlements" ADD CONSTRAINT "loyalty_program_entitlements_program_business_fk" FOREIGN KEY ("program_id","business_id") REFERENCES "public"."loyalty_programs"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_events" ADD CONSTRAINT "loyalty_program_events_program_business_fk" FOREIGN KEY ("program_id","business_id") REFERENCES "public"."loyalty_programs"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress" ADD CONSTRAINT "loyalty_program_progress_loyalty_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("loyalty_account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress" ADD CONSTRAINT "loyalty_program_progress_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress" ADD CONSTRAINT "loyalty_program_progress_program_business_fk" FOREIGN KEY ("program_id","business_id") REFERENCES "public"."loyalty_programs"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress_events" ADD CONSTRAINT "loyalty_program_progress_events_progress_id_loyalty_program_progress_id_fk" FOREIGN KEY ("progress_id") REFERENCES "public"."loyalty_program_progress"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress_events" ADD CONSTRAINT "loyalty_program_progress_events_loyalty_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("loyalty_account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress_events" ADD CONSTRAINT "loyalty_program_progress_events_purchase_event_id_loyalty_purchase_events_id_fk" FOREIGN KEY ("purchase_event_id") REFERENCES "public"."loyalty_purchase_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_progress_events" ADD CONSTRAINT "loyalty_program_progress_events_program_business_fk" FOREIGN KEY ("program_id","business_id") REFERENCES "public"."loyalty_programs"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_setup" ADD CONSTRAINT "loyalty_program_setup_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_program_versions" ADD CONSTRAINT "loyalty_program_versions_program_business_fk" FOREIGN KEY ("program_id","business_id") REFERENCES "public"."loyalty_programs"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_programs" ADD CONSTRAINT "loyalty_programs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_program_entitlements_source_uq" ON "loyalty_program_entitlements" USING btree ("program_id","loyalty_account_id","source_key");--> statement-breakpoint
CREATE INDEX "loyalty_program_entitlements_account_status_idx" ON "loyalty_program_entitlements" USING btree ("loyalty_account_id","status");--> statement-breakpoint
CREATE INDEX "loyalty_program_events_program_idx" ON "loyalty_program_events" USING btree ("program_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_program_progress_program_account_uq" ON "loyalty_program_progress" USING btree ("program_id","loyalty_account_id");--> statement-breakpoint
CREATE INDEX "loyalty_program_progress_account_idx" ON "loyalty_program_progress" USING btree ("loyalty_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_program_progress_events_source_uq" ON "loyalty_program_progress_events" USING btree ("program_id","source_key");--> statement-breakpoint
CREATE INDEX "loyalty_program_progress_events_progress_idx" ON "loyalty_program_progress_events" USING btree ("progress_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_program_versions_program_version_uq" ON "loyalty_program_versions" USING btree ("program_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "loyalty_programs_one_active_per_business" ON "loyalty_programs" USING btree ("business_id") WHERE "loyalty_programs"."status" = 'active';--> statement-breakpoint
CREATE INDEX "loyalty_programs_business_status_idx" ON "loyalty_programs" USING btree ("business_id","status");--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_program_id_loyalty_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."loyalty_programs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_program_provenance_check" CHECK (("loyalty_transactions"."program_id" IS NULL) = ("loyalty_transactions"."program_version" IS NULL));--> statement-breakpoint
-- ===== LOYALTY-PROGRAMME-COMPLETION, Group 01: database guards (hand-written) =====
CREATE OR REPLACE FUNCTION loyalty_programs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_NOT_DELETABLE: a programme is retired, never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' AND NOT (NEW.legacy AND NEW.status = 'active') THEN
      RAISE EXCEPTION 'LOYALTY_PROGRAM_BAD_INITIAL_STATE: a programme starts as draft (only the legacy backfill may start active)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.type <> OLD.type OR NEW.legacy <> OLD.legacy
     OR NEW.created_at <> OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_IMMUTABLE_FIELD: business, type, legacy flag and creation fields never change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.current_version < OLD.current_version OR NEW.current_version > OLD.current_version + 1 THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_VERSION_NOT_ALLOWED: the version only moves forward by one' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.current_version <> OLD.current_version AND NOT (NEW.status IN ('draft', 'active') AND OLD.status IN ('draft', 'validated', 'active')) THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_VERSION_NOT_ALLOWED: only a draft or active programme can take a new configuration version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft'     AND NEW.status IN ('validated', 'retired'))
    OR (OLD.status = 'validated' AND NEW.status IN ('draft', 'active', 'retired'))
    OR (OLD.status = 'active'    AND NEW.status = 'inactive')
    OR (OLD.status = 'inactive'  AND NEW.status IN ('active', 'retired'))
  ) THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_BAD_TRANSITION (% to %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'retired' AND (NEW.status <> 'retired' OR NEW.current_version <> OLD.current_version) THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_RETIRED: a retired programme is never reused' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'active' AND NOT EXISTS (
       SELECT 1 FROM loyalty_program_versions v WHERE v.program_id = NEW.id AND v.version = NEW.current_version) THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_NO_CONFIGURATION: an active programme needs its configuration version' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loyalty_programs_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON loyalty_programs FOR EACH ROW EXECUTE FUNCTION loyalty_programs_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION loyalty_program_append_only_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE last_version integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_APPEND_ONLY (% on %): history is never rewritten', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_TABLE_NAME = 'loyalty_program_versions' THEN
    SELECT max(version) INTO last_version FROM loyalty_program_versions WHERE program_id = NEW.program_id;
    IF NEW.version <> COALESCE(last_version, 0) + 1 THEN
      RAISE EXCEPTION 'LOYALTY_PROGRAM_VERSION_NOT_ALLOWED (versions are contiguous)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'loyalty_program_progress_events' THEN
    IF NOT EXISTS (SELECT 1 FROM loyalty_accounts a WHERE a.id = NEW.loyalty_account_id AND a.business_id = NEW.business_id)
       OR NOT EXISTS (SELECT 1 FROM loyalty_program_progress p WHERE p.id = NEW.progress_id AND p.program_id = NEW.program_id AND p.loyalty_account_id = NEW.loyalty_account_id AND p.business_id = NEW.business_id)
       OR (NEW.purchase_event_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM loyalty_purchase_events e WHERE e.id = NEW.purchase_event_id AND e.business_id = NEW.business_id AND e.loyalty_account_id = NEW.loyalty_account_id)) THEN
      RAISE EXCEPTION 'LOYALTY_PROGRAM_TENANT_MISMATCH: the entry does not belong to this business, programme, account and purchase' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loyalty_program_versions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON loyalty_program_versions FOR EACH ROW EXECUTE FUNCTION loyalty_program_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_events_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON loyalty_program_events FOR EACH ROW EXECUTE FUNCTION loyalty_program_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_progress_events_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON loyalty_program_progress_events FOR EACH ROW EXECUTE FUNCTION loyalty_program_append_only_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION loyalty_program_progress_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_PROGRESS_NOT_DELETABLE: progress is frozen, never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM loyalty_accounts a WHERE a.id = NEW.loyalty_account_id AND a.business_id = NEW.business_id AND a.customer_id = NEW.customer_id) THEN
      RAISE EXCEPTION 'LOYALTY_PROGRAM_TENANT_MISMATCH: the account does not belong to this business and customer' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.program_id <> OLD.program_id OR NEW.loyalty_account_id <> OLD.loyalty_account_id OR NEW.customer_id <> OLD.customer_id THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_IMMUTABLE_FIELD: progress identity never changes' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.frozen_at IS NOT NULL AND NEW.counters IS DISTINCT FROM OLD.counters THEN
    RAISE EXCEPTION 'LOYALTY_PROGRAM_PROGRESS_FROZEN: a frozen programme''s progress does not change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loyalty_program_progress_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON loyalty_program_progress FOR EACH ROW EXECUTE FUNCTION loyalty_program_progress_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION loyalty_program_entitlements_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LOYALTY_ENTITLEMENT_NOT_DELETABLE: an earned entitlement is never deleted' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'available' THEN
      RAISE EXCEPTION 'LOYALTY_ENTITLEMENT_BAD_INITIAL_STATE: an entitlement starts available' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM loyalty_accounts a WHERE a.id = NEW.loyalty_account_id AND a.business_id = NEW.business_id)
       OR NOT EXISTS (SELECT 1 FROM loyalty_rewards r WHERE r.id = NEW.reward_id AND r.business_id = NEW.business_id) THEN
      RAISE EXCEPTION 'LOYALTY_PROGRAM_TENANT_MISMATCH: the account and reward must belong to this business' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.business_id <> OLD.business_id OR NEW.program_id <> OLD.program_id OR NEW.program_version <> OLD.program_version
     OR NEW.loyalty_account_id <> OLD.loyalty_account_id OR NEW.reward_id <> OLD.reward_id OR NEW.source_key <> OLD.source_key
     OR NEW.earned_at <> OLD.earned_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'LOYALTY_ENTITLEMENT_IMMUTABLE_FIELD' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status <> OLD.status AND OLD.status <> 'available' THEN
    RAISE EXCEPTION 'LOYALTY_ENTITLEMENT_FINAL: a used, expired or reversed entitlement never changes again' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'redeemed' AND (NEW.redeemed_at IS NULL OR NEW.redeemed_by IS NULL) THEN
    RAISE EXCEPTION 'LOYALTY_ENTITLEMENT_REDEMPTION_EVIDENCE: a redemption records when and by whom' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER loyalty_program_entitlements_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON loyalty_program_entitlements FOR EACH ROW EXECUTE FUNCTION loyalty_program_entitlements_guard();
--> statement-breakpoint
CREATE TRIGGER loyalty_programs_no_truncate BEFORE TRUNCATE ON loyalty_programs FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_versions_no_truncate BEFORE TRUNCATE ON loyalty_program_versions FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_events_no_truncate BEFORE TRUNCATE ON loyalty_program_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_progress_no_truncate BEFORE TRUNCATE ON loyalty_program_progress FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_progress_events_no_truncate BEFORE TRUNCATE ON loyalty_program_progress_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER loyalty_program_entitlements_no_truncate BEFORE TRUNCATE ON loyalty_program_entitlements FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE loyalty_programs ENABLE ALWAYS TRIGGER loyalty_programs_guard_trg;
--> statement-breakpoint
ALTER TABLE loyalty_program_versions ENABLE ALWAYS TRIGGER loyalty_program_versions_guard_trg;
--> statement-breakpoint
ALTER TABLE loyalty_program_events ENABLE ALWAYS TRIGGER loyalty_program_events_guard_trg;
--> statement-breakpoint
ALTER TABLE loyalty_program_progress ENABLE ALWAYS TRIGGER loyalty_program_progress_guard_trg;
--> statement-breakpoint
ALTER TABLE loyalty_program_progress_events ENABLE ALWAYS TRIGGER loyalty_program_progress_events_guard_trg;
--> statement-breakpoint
ALTER TABLE loyalty_program_entitlements ENABLE ALWAYS TRIGGER loyalty_program_entitlements_guard_trg;
--> statement-breakpoint
ALTER TABLE loyalty_programs ENABLE ALWAYS TRIGGER loyalty_programs_no_truncate;
--> statement-breakpoint
ALTER TABLE loyalty_program_versions ENABLE ALWAYS TRIGGER loyalty_program_versions_no_truncate;
--> statement-breakpoint
ALTER TABLE loyalty_program_events ENABLE ALWAYS TRIGGER loyalty_program_events_no_truncate;
--> statement-breakpoint
ALTER TABLE loyalty_program_progress ENABLE ALWAYS TRIGGER loyalty_program_progress_no_truncate;
--> statement-breakpoint
ALTER TABLE loyalty_program_progress_events ENABLE ALWAYS TRIGGER loyalty_program_progress_events_no_truncate;
--> statement-breakpoint
ALTER TABLE loyalty_program_entitlements ENABLE ALWAYS TRIGGER loyalty_program_entitlements_no_truncate;
--> statement-breakpoint
-- ===== Legacy backfill (RW-D2 / REWARD-CONFIG-01 section 3.6): every existing business keeps EXACTLY its current earning =====
-- One active LP-03 programme per existing business reproducing loyalty_settings (or the table defaults when the business never had a
-- settings row). Balances, ledger rows, rewards and tiers are not touched. Three statements so each trigger sees the previous rows.
INSERT INTO loyalty_programs (id, business_id, type, status, current_version, legacy, activated_at, created_at, updated_at)
SELECT gen_random_uuid(), b.id, 'LP-03', 'active', 1, true, now(), now(), now()
FROM businesses b
WHERE NOT EXISTS (SELECT 1 FROM loyalty_programs p WHERE p.business_id = b.id);
--> statement-breakpoint
INSERT INTO loyalty_program_versions (id, program_id, business_id, version, config, config_hash)
SELECT gen_random_uuid(), p.id, p.business_id, 1, c.config, encode(sha256(convert_to(c.config::text, 'UTF8')), 'hex')
FROM loyalty_programs p
LEFT JOIN loyalty_settings s ON s.business_id = p.business_id
CROSS JOIN LATERAL (SELECT jsonb_build_object(
  'pointsPerCurrencyUnit', COALESCE(s.points_per_currency_unit, 1.00)::text,
  'pointsPerCheckin', COALESCE(s.points_per_checkin, 10),
  'rounding', 'floor',
  'legacy', true) AS config) c
WHERE p.legacy = true;
--> statement-breakpoint
INSERT INTO loyalty_program_events (id, business_id, program_id, event_type, from_status, to_status, version, metadata)
SELECT gen_random_uuid(), p.business_id, p.id, 'legacy_backfill', NULL, 'active', 1,
  jsonb_build_object('reason', 'existing business keeps its current earning configuration')
FROM loyalty_programs p WHERE p.legacy = true;
