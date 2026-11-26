CREATE TABLE "shuffle_drop_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"selection_result_id" uuid NOT NULL,
	"campaign_version_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sponsorship_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shuffle_drop_allocations_synthetic" CHECK ("shuffle_drop_allocations"."synthetic" = true)
);
--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_selection_result_id_shuffle_selection_results_id_fk" FOREIGN KEY ("selection_result_id") REFERENCES "public"."shuffle_selection_results"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_campaign_version_id_shuffle_campaign_versions_id_fk" FOREIGN KEY ("campaign_version_id") REFERENCES "public"."shuffle_campaign_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_entry_id_shuffle_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."shuffle_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_sponsorship_id_drop_sponsorships_id_fk" FOREIGN KEY ("sponsorship_id") REFERENCES "public"."drop_sponsorships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_reservation_id_drop_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."drop_reservations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shuffle_drop_allocations" ADD CONSTRAINT "shuffle_drop_allocations_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_drop_allocations_entry_uq" ON "shuffle_drop_allocations" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shuffle_drop_allocations_reservation_uq" ON "shuffle_drop_allocations" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "shuffle_drop_allocations_version_idx" ON "shuffle_drop_allocations" USING btree ("campaign_version_id","sponsorship_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION shuffle_drop_allocations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE sel_version uuid; sel_ok boolean; e_version uuid; e_customer uuid; e_status text; r_spons uuid; r_customer uuid; r_status text; c_status text;
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'SHUFFLE_DROP_ALLOCATION_APPEND_ONLY (%): an allocation is never withdrawn or rewritten through this table', TG_OP USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT campaign_version_id, selected_entry_ids @> to_jsonb(NEW.entry_id::text) INTO sel_version, sel_ok FROM shuffle_selection_results WHERE id = NEW.selection_result_id;
  SELECT campaign_version_id, customer_id, status INTO e_version, e_customer, e_status FROM shuffle_entries WHERE id = NEW.entry_id;
  SELECT sponsorship_id, customer_id, status INTO r_spons, r_customer, r_status FROM drop_reservations WHERE id = NEW.reservation_id;
  SELECT c.status INTO c_status FROM shuffle_campaign_versions v JOIN shuffle_campaigns c ON c.id = v.campaign_id WHERE v.id = NEW.campaign_version_id;
  IF sel_version IS DISTINCT FROM NEW.campaign_version_id OR sel_ok IS DISTINCT FROM true
     OR e_version IS DISTINCT FROM NEW.campaign_version_id OR e_customer IS DISTINCT FROM NEW.customer_id OR e_status IS DISTINCT FROM 'admitted'
     OR r_spons IS DISTINCT FROM NEW.sponsorship_id OR r_customer IS DISTINCT FROM NEW.customer_id OR r_status NOT IN ('allocated','collected')
     OR c_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'SHUFFLE_DROP_ALLOCATION_NOT_ALLOWED (the entry must be an admitted, SELECTED entry of this recorded selection, and the unit an allocated reservation of the same customer on this sponsorship, in an active campaign)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER shuffle_drop_allocations_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON shuffle_drop_allocations FOR EACH ROW EXECUTE FUNCTION shuffle_drop_allocations_guard();
--> statement-breakpoint
CREATE TRIGGER shuffle_drop_allocations_no_truncate BEFORE TRUNCATE ON shuffle_drop_allocations FOR EACH STATEMENT EXECUTE FUNCTION network_truncate_denied();
--> statement-breakpoint
ALTER TABLE shuffle_drop_allocations ENABLE ALWAYS TRIGGER shuffle_drop_allocations_guard_trg;
--> statement-breakpoint
ALTER TABLE shuffle_drop_allocations ENABLE ALWAYS TRIGGER shuffle_drop_allocations_no_truncate;
