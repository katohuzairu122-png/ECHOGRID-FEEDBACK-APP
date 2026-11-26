CREATE TABLE "shuffle_allocation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"event" jsonb NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_allocation_events_seq_uq" UNIQUE("campaign_version_id","seq"),
	CONSTRAINT "shuffle_allocation_events_seq_pos" CHECK ("shuffle_allocation_events"."seq" >= 1),
	CONSTRAINT "shuffle_allocation_events_hash" CHECK ("shuffle_allocation_events"."hash" ~ '^[0-9a-f]{64}$' AND ("shuffle_allocation_events"."prev_hash" IS NULL OR "shuffle_allocation_events"."prev_hash" ~ '^[0-9a-f]{64}$') AND (("shuffle_allocation_events"."seq" = 1) = ("shuffle_allocation_events"."prev_hash" IS NULL)))
);
--> statement-breakpoint
CREATE TABLE "shuffle_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"accepted_terms_version" text NOT NULL,
	"accepted_disclosure_hash" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"status_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_entries_id_version_uq" UNIQUE("id","campaign_version_id"),
	CONSTRAINT "shuffle_entries_status_valid" CHECK ("shuffle_entries"."status" IN ('accepted','admitted','rejected','cancelled')),
	CONSTRAINT "shuffle_entries_synthetic" CHECK ("shuffle_entries"."synthetic" = true),
	CONSTRAINT "shuffle_entries_hash" CHECK ("shuffle_entries"."accepted_disclosure_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "shuffle_invitation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_invitation_events_to_valid" CHECK ("shuffle_invitation_events"."to_status" IN ('generated','viewed','accepted','declined','expired','withdrawn'))
);
--> statement-breakpoint
CREATE TABLE "shuffle_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"status" text DEFAULT 'generated' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_invitations_id_version_customer_uq" UNIQUE("id","campaign_version_id","customer_id"),
	CONSTRAINT "shuffle_invitations_status_valid" CHECK ("shuffle_invitations"."status" IN ('generated','viewed','accepted','declined','expired','withdrawn')),
	CONSTRAINT "shuffle_invitations_synthetic" CHECK ("shuffle_invitations"."synthetic" = true)
);
--> statement-breakpoint
CREATE TABLE "shuffle_notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"channel" text DEFAULT 'in_app' NOT NULL,
	"delivery_state" text DEFAULT 'held' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_notification_intents_held" CHECK ("shuffle_notification_intents"."delivery_state" = 'held' AND "shuffle_notification_intents"."channel" = 'in_app')
);
--> statement-breakpoint
CREATE TABLE "shuffle_selection_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"entrant_count" integer NOT NULL,
	"winner_count" integer NOT NULL,
	"selected_entry_ids" jsonb NOT NULL,
	"input_commitment" text NOT NULL,
	"result_commitment" text NOT NULL,
	"transcript" jsonb NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_selection_results_counts" CHECK ("shuffle_selection_results"."winner_count" >= 1 AND "shuffle_selection_results"."winner_count" <= "shuffle_selection_results"."entrant_count"),
	CONSTRAINT "shuffle_selection_results_hashes" CHECK ("shuffle_selection_results"."input_commitment" ~ '^[0-9a-f]{64}$' AND "shuffle_selection_results"."result_commitment" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "shuffle_selection_results_synthetic" CHECK ("shuffle_selection_results"."synthetic" = true)
);
--> statement-breakpoint
ALTER TABLE "shuffle_allocation_events" ADD CONSTRAINT "shuffle_allocation_events_campaign_version_id_shuffle_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."shuffle_campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_allocation_events" ADD CONSTRAINT "shuffle_allocation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_entries" ADD CONSTRAINT "shuffle_entries_invitation_fk" FOREIGN KEY ("invitation_id","campaign_version_id","customer_id") REFERENCES "public"."shuffle_invitations"("id","campaign_version_id","customer_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_invitation_events" ADD CONSTRAINT "shuffle_invitation_events_invitation_id_shuffle_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."shuffle_invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_invitation_events" ADD CONSTRAINT "shuffle_invitation_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_invitations" ADD CONSTRAINT "shuffle_invitations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_invitations" ADD CONSTRAINT "shuffle_invitations_snapshot_id_shuffle_eligibility_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."shuffle_eligibility_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_invitations" ADD CONSTRAINT "shuffle_invitations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_invitations" ADD CONSTRAINT "shuffle_invitations_version_fk" FOREIGN KEY ("campaign_version_id","campaign_id") REFERENCES "public"."shuffle_campaign_versions"("id","campaign_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_notification_intents" ADD CONSTRAINT "shuffle_notification_intents_invitation_id_shuffle_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."shuffle_invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_selection_results" ADD CONSTRAINT "shuffle_selection_results_campaign_version_id_shuffle_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."shuffle_campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_selection_results" ADD CONSTRAINT "shuffle_selection_results_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_entries_invitation_uq" ON "shuffle_entries" USING btree ("invitation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_entries_version_customer_uq" ON "shuffle_entries" USING btree ("campaign_version_id","customer_id");--> statement-breakpoint
CREATE INDEX "shuffle_entries_version_status_idx" ON "shuffle_entries" USING btree ("campaign_version_id","status");--> statement-breakpoint
CREATE INDEX "shuffle_invitation_events_inv_idx" ON "shuffle_invitation_events" USING btree ("invitation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_invitations_snapshot_uq" ON "shuffle_invitations" USING btree ("snapshot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_invitations_version_customer_uq" ON "shuffle_invitations" USING btree ("campaign_version_id","customer_id");--> statement-breakpoint
CREATE INDEX "shuffle_invitations_customer_idx" ON "shuffle_invitations" USING btree ("customer_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_notification_intents_once_uq" ON "shuffle_notification_intents" USING btree ("invitation_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_selection_results_version_uq" ON "shuffle_selection_results" USING btree ("campaign_version_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_invitations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE c_status text; v_deadline timestamptz; s_ok boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SHUFFLE_INVITATION_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT c.status, v.entry_acceptance_deadline INTO c_status, v_deadline
    FROM shuffle_campaign_versions v JOIN shuffle_campaigns c ON c.id = v.campaign_id WHERE v.id = NEW.campaign_version_id;
  IF TG_OP = 'INSERT' THEN
    SELECT s.qualified INTO s_ok FROM shuffle_eligibility_snapshots s
     WHERE s.id = NEW.snapshot_id AND s.campaign_version_id = NEW.campaign_version_id AND s.customer_id = NEW.customer_id;
    IF NEW.status <> 'generated' OR s_ok IS DISTINCT FROM true OR c_status <> 'draft' OR NEW.expires_at <= now() OR NEW.expires_at > v_deadline THEN
      RAISE EXCEPTION 'SHUFFLE_INVITATION_NOT_ALLOWED (needs a qualified snapshot of this version and customer, an active campaign and an expiry within the acceptance deadline)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.campaign_id <> OLD.campaign_id OR NEW.campaign_version_id <> OLD.campaign_version_id OR NEW.customer_id <> OLD.customer_id
     OR NEW.snapshot_id <> OLD.snapshot_id OR NEW.expires_at <> OLD.expires_at OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SHUFFLE_INVITATION_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.status IN ('generated','viewed') AND NEW.status IN ('viewed','accepted','declined','withdrawn'))
     OR (OLD.status = 'generated' AND NEW.status = 'viewed')
     OR (OLD.status IN ('generated','viewed') AND NEW.status = 'expired' AND OLD.expires_at <= now())
     OR (OLD.status = 'accepted' AND NEW.status = 'withdrawn') THEN
    IF NEW.status = 'accepted' AND (c_status <> 'draft' OR OLD.expires_at <= now() OR v_deadline < now()) THEN
      RAISE EXCEPTION 'SHUFFLE_INVITATION_NOT_ACCEPTABLE (campaign not active or invitation expired)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SHUFFLE_INVITATION_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_entries_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE c_status text; v_deadline timestamptz; v_terms text; v_hash text; v_max integer; i_status text; admitted integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SHUFFLE_ENTRY_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT c.status, v.entry_acceptance_deadline, v.terms_version, v.disclosure_hash, v.max_capacity INTO c_status, v_deadline, v_terms, v_hash, v_max
    FROM shuffle_campaign_versions v JOIN shuffle_campaigns c ON c.id = v.campaign_id WHERE v.id = NEW.campaign_version_id;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO i_status FROM shuffle_invitations WHERE id = NEW.invitation_id;
    IF NEW.status <> 'accepted' OR i_status IS DISTINCT FROM 'accepted' OR c_status <> 'draft' OR now() > v_deadline
       OR NEW.accepted_terms_version <> v_terms OR NEW.accepted_disclosure_hash <> v_hash THEN
      RAISE EXCEPTION 'SHUFFLE_ENTRY_NOT_ALLOWED (needs an accepted invitation, an active campaign, the deadline not passed and the exact terms and disclosure of this version)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.invitation_id <> OLD.invitation_id OR NEW.campaign_version_id <> OLD.campaign_version_id OR NEW.customer_id <> OLD.customer_id
     OR NEW.accepted_terms_version <> OLD.accepted_terms_version OR NEW.accepted_disclosure_hash <> OLD.accepted_disclosure_hash OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'SHUFFLE_ENTRY_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF (OLD.status = 'accepted' AND NEW.status IN ('admitted','rejected','cancelled')) OR (OLD.status = 'admitted' AND NEW.status = 'cancelled') THEN
    IF NEW.status = 'admitted' THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('shuffle_admit:' || NEW.campaign_version_id::text, 0));
      SELECT count(*) INTO admitted FROM shuffle_entries WHERE campaign_version_id = NEW.campaign_version_id AND status = 'admitted';
      IF c_status <> 'draft' OR admitted >= v_max THEN
        RAISE EXCEPTION 'SHUFFLE_ENTRY_CAPACITY_OR_STATE (campaign not active or capacity reached)' USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END IF;
    IF NEW.status IN ('rejected','cancelled') AND NEW.status_reason IS NULL THEN
      RAISE EXCEPTION 'SHUFFLE_ENTRY_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SHUFFLE_ENTRY_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_allocation_events_chain() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE last_seq integer; last_hash text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('shuffle_chain:' || NEW.campaign_version_id::text, 0));
  SELECT seq, hash INTO last_seq, last_hash FROM shuffle_allocation_events WHERE campaign_version_id = NEW.campaign_version_id ORDER BY seq DESC LIMIT 1;
  IF NEW.seq <> COALESCE(last_seq, 0) + 1 OR NEW.prev_hash IS DISTINCT FROM last_hash THEN
    RAISE EXCEPTION 'SHUFFLE_CHAIN_BROKEN (sequence or previous hash does not extend the chain)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_selection_results_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE c_status text; v_min integer; admitted integer;
BEGIN
  SELECT c.status, v.min_participants INTO c_status, v_min FROM shuffle_campaign_versions v JOIN shuffle_campaigns c ON c.id = v.campaign_id WHERE v.id = NEW.campaign_version_id;
  PERFORM pg_advisory_xact_lock(hashtextextended('shuffle_admit:' || NEW.campaign_version_id::text, 0));
  SELECT count(*) INTO admitted FROM shuffle_entries WHERE campaign_version_id = NEW.campaign_version_id AND status = 'admitted';
  IF c_status <> 'draft' OR admitted < v_min OR NEW.entrant_count <> admitted
     OR jsonb_typeof(NEW.selected_entry_ids) <> 'array' OR jsonb_array_length(NEW.selected_entry_ids) <> NEW.winner_count THEN
    RAISE EXCEPTION 'SHUFFLE_SELECTION_NOT_ALLOWED (campaign not active, below minimum participants, or result inconsistent with the admitted entries)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shuffle_invitations_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON shuffle_invitations FOR EACH ROW EXECUTE FUNCTION shuffle_invitations_guard();
--> statement-breakpoint
CREATE TRIGGER shuffle_entries_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON shuffle_entries FOR EACH ROW EXECUTE FUNCTION shuffle_entries_guard();
--> statement-breakpoint
CREATE TRIGGER shuffle_allocation_events_chain_trg BEFORE INSERT ON shuffle_allocation_events FOR EACH ROW EXECUTE FUNCTION shuffle_allocation_events_chain();
--> statement-breakpoint
CREATE TRIGGER shuffle_selection_results_guard_trg BEFORE INSERT ON shuffle_selection_results FOR EACH ROW EXECUTE FUNCTION shuffle_selection_results_guard();
--> statement-breakpoint
CREATE TRIGGER shuffle_inv_events_append_only_trg BEFORE UPDATE OR DELETE ON shuffle_invitation_events FOR EACH ROW EXECUTE FUNCTION shuffle_append_only();
--> statement-breakpoint
CREATE TRIGGER shuffle_notif_append_only_trg BEFORE UPDATE OR DELETE ON shuffle_notification_intents FOR EACH ROW EXECUTE FUNCTION shuffle_append_only();
--> statement-breakpoint
CREATE TRIGGER shuffle_alloc_events_append_only_trg BEFORE UPDATE OR DELETE ON shuffle_allocation_events FOR EACH ROW EXECUTE FUNCTION shuffle_append_only();
--> statement-breakpoint
CREATE TRIGGER shuffle_selection_append_only_trg BEFORE UPDATE OR DELETE ON shuffle_selection_results FOR EACH ROW EXECUTE FUNCTION shuffle_append_only();
--> statement-breakpoint
CREATE TRIGGER shuffle_invitations_no_truncate BEFORE TRUNCATE ON shuffle_invitations FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_inv_events_no_truncate BEFORE TRUNCATE ON shuffle_invitation_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_notif_no_truncate BEFORE TRUNCATE ON shuffle_notification_intents FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_entries_no_truncate BEFORE TRUNCATE ON shuffle_entries FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_alloc_events_no_truncate BEFORE TRUNCATE ON shuffle_allocation_events FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
CREATE TRIGGER shuffle_selection_no_truncate BEFORE TRUNCATE ON shuffle_selection_results FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE shuffle_invitations ENABLE ALWAYS TRIGGER shuffle_invitations_guard_trg;
--> statement-breakpoint
ALTER TABLE shuffle_entries ENABLE ALWAYS TRIGGER shuffle_entries_guard_trg;
--> statement-breakpoint
ALTER TABLE shuffle_allocation_events ENABLE ALWAYS TRIGGER shuffle_allocation_events_chain_trg;
--> statement-breakpoint
ALTER TABLE shuffle_selection_results ENABLE ALWAYS TRIGGER shuffle_selection_results_guard_trg;
--> statement-breakpoint
ALTER TABLE shuffle_invitation_events ENABLE ALWAYS TRIGGER shuffle_inv_events_append_only_trg;
--> statement-breakpoint
ALTER TABLE shuffle_notification_intents ENABLE ALWAYS TRIGGER shuffle_notif_append_only_trg;
--> statement-breakpoint
ALTER TABLE shuffle_allocation_events ENABLE ALWAYS TRIGGER shuffle_alloc_events_append_only_trg;
--> statement-breakpoint
ALTER TABLE shuffle_selection_results ENABLE ALWAYS TRIGGER shuffle_selection_append_only_trg;
--> statement-breakpoint
ALTER TABLE shuffle_invitations ENABLE ALWAYS TRIGGER shuffle_invitations_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_invitation_events ENABLE ALWAYS TRIGGER shuffle_inv_events_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_notification_intents ENABLE ALWAYS TRIGGER shuffle_notif_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_entries ENABLE ALWAYS TRIGGER shuffle_entries_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_allocation_events ENABLE ALWAYS TRIGGER shuffle_alloc_events_no_truncate;
--> statement-breakpoint
ALTER TABLE shuffle_selection_results ENABLE ALWAYS TRIGGER shuffle_selection_no_truncate;
