CREATE TABLE "drop_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sponsorship_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"event" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_events_seq_uq" UNIQUE("sponsorship_id","seq"),
	CONSTRAINT "drop_events_hash" CHECK ("drop_events"."hash" ~ '^[0-9a-f]{64}$' AND ("drop_events"."prev_hash" IS NULL OR "drop_events"."prev_hash" ~ '^[0-9a-f]{64}$') AND "drop_events"."seq" >= 1 AND (("drop_events"."seq" = 1) = ("drop_events"."prev_hash" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "drop_inventory" (
	"sponsorship_id" uuid PRIMARY KEY NOT NULL,
	"total_quantity" integer NOT NULL,
	"reserved" integer DEFAULT 0 NOT NULL,
	"allocated" integer DEFAULT 0 NOT NULL,
	"collected" integer DEFAULT 0 NOT NULL,
	"expired" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_inventory_non_negative" CHECK ("drop_inventory"."total_quantity" >= 1 AND "drop_inventory"."reserved" >= 0 AND "drop_inventory"."allocated" >= 0 AND "drop_inventory"."collected" >= 0 AND "drop_inventory"."expired" >= 0),
	CONSTRAINT "drop_inventory_no_oversubscription" CHECK ("drop_inventory"."reserved" + "drop_inventory"."allocated" + "drop_inventory"."collected" + "drop_inventory"."expired" <= "drop_inventory"."total_quantity")
);
--> statement-breakpoint
CREATE TABLE "drop_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sponsorship_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"hold_expires_at" timestamp with time zone NOT NULL,
	"eligibility_evidence" jsonb NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_reservations_status_valid" CHECK ("drop_reservations"."status" IN ('reserved','allocated','collected','released','expired')),
	CONSTRAINT "drop_reservations_synthetic" CHECK ("drop_reservations"."synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "drop_sponsorship_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sponsorship_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"product_name" text NOT NULL,
	"description" text NOT NULL,
	"quantity_total" integer NOT NULL,
	"eligible_participant_type" text DEFAULT 'customer' NOT NULL,
	"collection_method" text NOT NULL,
	"collection_location" text NOT NULL,
	"collection_window_start" timestamp with time zone NOT NULL,
	"collection_window_end" timestamp with time zone NOT NULL,
	"offer_expires_at" timestamp with time zone NOT NULL,
	"qualification_rule_version_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_sponsorship_versions_uq" UNIQUE("sponsorship_id","version"),
	CONSTRAINT "drop_sponsorship_versions_id_sponsorship_uq" UNIQUE("id","sponsorship_id"),
	CONSTRAINT "drop_versions_quantity" CHECK ("drop_sponsorship_versions"."quantity_total" >= 1 AND "drop_sponsorship_versions"."quantity_total" <= 1000000),
	CONSTRAINT "drop_versions_participant" CHECK ("drop_sponsorship_versions"."eligible_participant_type" = 'customer'),
	CONSTRAINT "drop_versions_windows" CHECK ("drop_sponsorship_versions"."collection_window_end" > "drop_sponsorship_versions"."collection_window_start" AND "drop_sponsorship_versions"."offer_expires_at" > "drop_sponsorship_versions"."created_at"),
	CONSTRAINT "drop_versions_text" CHECK (char_length("drop_sponsorship_versions"."product_name") BETWEEN 1 AND 120 AND char_length("drop_sponsorship_versions"."description") BETWEEN 1 AND 1000 AND char_length("drop_sponsorship_versions"."collection_method") BETWEEN 1 AND 300 AND char_length("drop_sponsorship_versions"."collection_location") BETWEEN 1 AND 300),
	CONSTRAINT "drop_versions_hash" CHECK ("drop_sponsorship_versions"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "drop_sponsorships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"business_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_version_id" uuid,
	"reviewed_by_user_id" uuid,
	"reviewed_at" timestamp with time zone,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drop_sponsorships_key_format" CHECK ("drop_sponsorships"."key" ~ '^[a-z][a-z0-9_]{2,63}$'),
	CONSTRAINT "drop_sponsorships_status_valid" CHECK ("drop_sponsorships"."status" IN ('draft','submitted','under_review','approved','scheduled','available','suspended','cancelled','expired')),
	CONSTRAINT "drop_sponsorships_synthetic" CHECK ("drop_sponsorships"."synthetic" = true),
	CONSTRAINT "drop_sponsorships_review_shape" CHECK (("drop_sponsorships"."reviewed_by_user_id" IS NULL) = ("drop_sponsorships"."reviewed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "drop_events" ADD CONSTRAINT "drop_events_sponsorship_id_drop_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."drop_sponsorships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_events" ADD CONSTRAINT "drop_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_inventory" ADD CONSTRAINT "drop_inventory_sponsorship_id_drop_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."drop_sponsorships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_reservations" ADD CONSTRAINT "drop_reservations_sponsorship_id_drop_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."drop_sponsorships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_reservations" ADD CONSTRAINT "drop_reservations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_reservations" ADD CONSTRAINT "drop_reservations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_sponsorship_versions" ADD CONSTRAINT "drop_sponsorship_versions_sponsorship_id_drop_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."drop_sponsorships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_sponsorship_versions" ADD CONSTRAINT "drop_sponsorship_versions_qualification_rule_version_id_qualification_rule_versions_id_fk" FOREIGN KEY ("qualification_rule_version_id") REFERENCES "public"."qualification_rule_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_sponsorship_versions" ADD CONSTRAINT "drop_sponsorship_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_sponsorships" ADD CONSTRAINT "drop_sponsorships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_sponsorships" ADD CONSTRAINT "drop_sponsorships_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drop_sponsorships" ADD CONSTRAINT "drop_sponsorships_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drop_reservations_once_uq" ON "drop_reservations" USING btree ("sponsorship_id","customer_id");--> statement-breakpoint
CREATE INDEX "drop_reservations_status_idx" ON "drop_reservations" USING btree ("sponsorship_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "drop_sponsorships_key_uq" ON "drop_sponsorships" USING btree ("key");--> statement-breakpoint
CREATE INDEX "drop_sponsorships_business_idx" ON "drop_sponsorships" USING btree ("business_id","status");--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_sponsorships_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE ok boolean := false; v_sponsorship uuid; v_qty integer; latest integer; chosen integer; has_inv boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_version_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_NOT_ALLOWED (starts as a draft without review)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.key <> OLD.key OR NEW.business_id <> OLD.business_id OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = NEW.status THEN
    IF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('submitted','cancelled'))
     OR (OLD.status = 'submitted' AND NEW.status IN ('under_review','cancelled'))
     OR (OLD.status = 'under_review' AND NEW.status IN ('approved','draft','cancelled'))
     OR (OLD.status = 'approved' AND NEW.status IN ('scheduled','suspended','cancelled'))
     OR (OLD.status = 'scheduled' AND NEW.status IN ('available','suspended','cancelled'))
     OR (OLD.status = 'available' AND NEW.status IN ('suspended','cancelled','expired'))
     OR (OLD.status = 'suspended' AND NEW.status IN ('available','cancelled'));
  IF NOT ok THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.status IN ('draft','suspended','cancelled') AND NEW.status_reason IS NULL THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    -- separation of duties: a reviewer who is not the creator, approving the LATEST version of this sponsorship
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id = OLD.created_by_user_id OR NEW.approved_version_id IS NULL THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_REVIEW_REQUIRED (an independent reviewer and the approved version are required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT max(version) INTO latest FROM drop_sponsorship_versions WHERE sponsorship_id = OLD.id;
    SELECT version INTO chosen FROM drop_sponsorship_versions WHERE id = NEW.approved_version_id AND sponsorship_id = OLD.id;
    IF chosen IS NULL OR chosen <> latest THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_REVIEW_REQUIRED (approve the latest version of this sponsorship)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    IF NOT (NEW.status = 'draft') THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  END IF;
  IF NEW.status = 'draft' AND (NEW.approved_version_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (a returned draft clears the review)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('scheduled','available') THEN
    SELECT EXISTS (SELECT 1 FROM drop_inventory WHERE sponsorship_id = OLD.id) INTO has_inv;
    IF NEW.approved_version_id IS NULL OR NOT has_inv THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_NOT_READY (approved version and inventory are required)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_versions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE s_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'DROP_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT status INTO s_status FROM drop_sponsorships WHERE id = NEW.sponsorship_id;
  IF s_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'DROP_VERSION_NOT_ALLOWED (versions can only be added while the sponsorship is a draft)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_inventory_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE v_qty integer; s_status text; s_approved uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, approved_version_id INTO s_status, s_approved FROM drop_sponsorships WHERE id = NEW.sponsorship_id;
    SELECT quantity_total INTO v_qty FROM drop_sponsorship_versions WHERE id = s_approved;
    IF s_status IS DISTINCT FROM 'approved' OR v_qty IS DISTINCT FROM NEW.total_quantity OR NEW.reserved <> 0 OR NEW.allocated <> 0 OR NEW.collected <> 0 OR NEW.expired <> 0 THEN
      RAISE EXCEPTION 'DROP_INVENTORY_NOT_ALLOWED (inventory is created once, empty, at the approved quantity of an approved sponsorship)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND NEW.sponsorship_id = OLD.sponsorship_id AND NEW.total_quantity = OLD.total_quantity AND NEW.created_at = OLD.created_at THEN
    RETURN NEW; -- only reachable from the reservation trigger (nested); a direct statement runs at depth 1 and is refused
  END IF;
  RAISE EXCEPTION 'DROP_INVENTORY_CONTROLLED (counters change only through reservations; no update, delete or truncate)' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_reservations_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE s_status text; w_end timestamptz; n integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DROP_RESERVATION_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT s.status, v.collection_window_end INTO s_status, w_end FROM drop_sponsorships s JOIN drop_sponsorship_versions v ON v.id = s.approved_version_id WHERE s.id = NEW.sponsorship_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' OR s_status IS DISTINCT FROM 'available' OR NEW.hold_expires_at <= now() THEN
      RAISE EXCEPTION 'DROP_RESERVATION_NOT_ALLOWED (needs an available sponsorship and a hold that expires in the future)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE drop_inventory SET reserved = reserved + 1
      WHERE sponsorship_id = NEW.sponsorship_id AND reserved + allocated + collected + expired < total_quantity;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'DROP_INVENTORY_EXHAUSTED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.sponsorship_id <> OLD.sponsorship_id OR NEW.customer_id <> OLD.customer_id OR NEW.hold_expires_at <> OLD.hold_expires_at OR NEW.eligibility_evidence <> OLD.eligibility_evidence
     OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'DROP_RESERVATION_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'allocated' THEN
    IF s_status IS DISTINCT FROM 'available' OR OLD.hold_expires_at <= now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_ALLOWED (sponsorship not available or the hold expired)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET reserved = reserved - 1, allocated = allocated + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'released' THEN
    UPDATE drop_inventory SET reserved = reserved - 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'expired' THEN
    IF OLD.hold_expires_at > now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_EXPIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET reserved = reserved - 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'allocated' AND NEW.status = 'collected' THEN
    UPDATE drop_inventory SET allocated = allocated - 1, collected = collected + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'allocated' AND NEW.status = 'expired' THEN
    IF w_end > now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_EXPIRED (collection window still open)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET allocated = allocated - 1, expired = expired + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = NEW.status THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'DROP_RESERVATION_TRANSITION_NOT_ALLOWED (% -> %); an allocated unit is never silently withdrawn', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('released') AND NEW.status_reason IS NULL THEN RAISE EXCEPTION 'DROP_RESERVATION_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_events_chain() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE last_seq integer; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('drop_chain:' || NEW.sponsorship_id::text, 0));
  SELECT seq, hash INTO last_seq, last_hash FROM drop_events WHERE sponsorship_id = NEW.sponsorship_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(last_seq, 0) + 1 OR NEW.prev_hash IS DISTINCT FROM last_hash THEN
    RAISE EXCEPTION 'DROP_CHAIN_BROKEN (sequence or previous hash does not extend the chain)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION drop_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'DROP_LEDGER_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER drop_sponsorships_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON drop_sponsorships FOR EACH ROW EXECUTE FUNCTION drop_sponsorships_guard();
--> statement-breakpoint
CREATE TRIGGER drop_versions_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON drop_sponsorship_versions FOR EACH ROW EXECUTE FUNCTION drop_versions_guard();
--> statement-breakpoint
CREATE TRIGGER drop_inventory_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON drop_inventory FOR EACH ROW EXECUTE FUNCTION drop_inventory_guard();
--> statement-breakpoint
CREATE TRIGGER drop_reservations_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON drop_reservations FOR EACH ROW EXECUTE FUNCTION drop_reservations_guard();
--> statement-breakpoint
CREATE TRIGGER drop_events_chain_trg BEFORE INSERT ON drop_events FOR EACH ROW EXECUTE FUNCTION drop_events_chain();
--> statement-breakpoint
CREATE TRIGGER drop_events_append_only_trg BEFORE UPDATE OR DELETE ON drop_events FOR EACH ROW EXECUTE FUNCTION drop_append_only();
--> statement-breakpoint
CREATE TRIGGER drop_sponsorships_no_truncate BEFORE TRUNCATE ON drop_sponsorships FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER drop_versions_no_truncate BEFORE TRUNCATE ON drop_sponsorship_versions FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER drop_inventory_no_truncate BEFORE TRUNCATE ON drop_inventory FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER drop_reservations_no_truncate BEFORE TRUNCATE ON drop_reservations FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER drop_events_no_truncate BEFORE TRUNCATE ON drop_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE drop_sponsorships ENABLE ALWAYS TRIGGER drop_sponsorships_guard_trg;
--> statement-breakpoint
ALTER TABLE drop_sponsorship_versions ENABLE ALWAYS TRIGGER drop_versions_guard_trg;
--> statement-breakpoint
ALTER TABLE drop_inventory ENABLE ALWAYS TRIGGER drop_inventory_guard_trg;
--> statement-breakpoint
ALTER TABLE drop_reservations ENABLE ALWAYS TRIGGER drop_reservations_guard_trg;
--> statement-breakpoint
ALTER TABLE drop_events ENABLE ALWAYS TRIGGER drop_events_chain_trg;
--> statement-breakpoint
ALTER TABLE drop_events ENABLE ALWAYS TRIGGER drop_events_append_only_trg;
--> statement-breakpoint
ALTER TABLE drop_sponsorships ENABLE ALWAYS TRIGGER drop_sponsorships_no_truncate;
--> statement-breakpoint
ALTER TABLE drop_sponsorship_versions ENABLE ALWAYS TRIGGER drop_versions_no_truncate;
--> statement-breakpoint
ALTER TABLE drop_inventory ENABLE ALWAYS TRIGGER drop_inventory_no_truncate;
--> statement-breakpoint
ALTER TABLE drop_reservations ENABLE ALWAYS TRIGGER drop_reservations_no_truncate;
--> statement-breakpoint
ALTER TABLE drop_events ENABLE ALWAYS TRIGGER drop_events_no_truncate;
