-- Split 07 disputed-award hold overlay (additive, forward-only, INERT). Depends on 0047 (award (id, business_id) key). 0040-0049, the award state
-- machine and every existing guard are untouched. All three tables are write-denied; only an isolated disposable database may disable the guards.
-- Events are append-only; a dispute and a correction can each be resolved exactly once; the database refuses self-approval of a correction.
CREATE TABLE "partner_credit_award_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"resolved_at" timestamp with time zone,
	"plan" jsonb,
	CONSTRAINT "partner_credit_award_disputes_id_business_key" UNIQUE("id","business_id"),
	CONSTRAINT "partner_credit_award_disputes_state_check" CHECK ("partner_credit_award_disputes"."state" IN ('open','released','revoked')),
	CONSTRAINT "partner_credit_award_disputes_revision_check" CHECK ("partner_credit_award_disputes"."revision" >= 1),
	CONSTRAINT "partner_credit_award_disputes_shape_check" CHECK (("partner_credit_award_disputes"."state" = 'open' AND "partner_credit_award_disputes"."resolved_at" IS NULL AND "partner_credit_award_disputes"."plan" IS NULL)
    OR ("partner_credit_award_disputes"."state" = 'released' AND "partner_credit_award_disputes"."resolved_at" IS NOT NULL AND "partner_credit_award_disputes"."plan" IS NULL)
    OR ("partner_credit_award_disputes"."state" = 'revoked' AND "partner_credit_award_disputes"."resolved_at" IS NOT NULL AND "partner_credit_award_disputes"."plan" IS NOT NULL AND jsonb_typeof("partner_credit_award_disputes"."plan") = 'object'))
);
--> statement-breakpoint
CREATE TABLE "partner_credit_corrections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispute_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text DEFAULT 'revoke_award' NOT NULL,
	"units" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"proposed_by" uuid NOT NULL,
	"proposed_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "partner_credit_corrections_dispute_kind_key" UNIQUE("dispute_id","kind"),
	CONSTRAINT "partner_credit_corrections_kind_check" CHECK ("partner_credit_corrections"."kind" = 'revoke_award'),
	CONSTRAINT "partner_credit_corrections_units_check" CHECK ("partner_credit_corrections"."units" = 1),
	CONSTRAINT "partner_credit_corrections_state_check" CHECK ("partner_credit_corrections"."state" IN ('proposed','approved','rejected')),
	CONSTRAINT "partner_credit_corrections_no_self_approval" CHECK ("partner_credit_corrections"."decided_by" IS NULL OR "partner_credit_corrections"."decided_by" <> "partner_credit_corrections"."proposed_by"),
	CONSTRAINT "partner_credit_corrections_decided_check" CHECK (("partner_credit_corrections"."state" = 'proposed') = ("partner_credit_corrections"."decided_by" IS NULL AND "partner_credit_corrections"."decided_at" IS NULL)),
	CONSTRAINT "partner_credit_corrections_note_check" CHECK ("partner_credit_corrections"."decision_note" IS NULL OR char_length("partner_credit_corrections"."decision_note") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "partner_credit_dispute_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "partner_credit_dispute_events_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dispute_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"actor_platform_role" text NOT NULL,
	"evidence_ref" text,
	"note" text,
	"dedupe_key" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "partner_credit_dispute_events_dedupe_key_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "partner_credit_dispute_events_kind_check" CHECK ("partner_credit_dispute_events"."kind" IN ('opened','evidence_added','resolved_upheld','resolved_revoked')),
	CONSTRAINT "partner_credit_dispute_events_role_check" CHECK ("partner_credit_dispute_events"."actor_platform_role" = 'admin'),
	CONSTRAINT "partner_credit_dispute_events_evidence_check" CHECK ("partner_credit_dispute_events"."evidence_ref" IS NOT NULL AND btrim("partner_credit_dispute_events"."evidence_ref") <> ''),
	CONSTRAINT "partner_credit_dispute_events_note_check" CHECK ("partner_credit_dispute_events"."note" IS NULL OR char_length("partner_credit_dispute_events"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "partner_credit_award_disputes" ADD CONSTRAINT "partner_credit_award_disputes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_award_disputes" ADD CONSTRAINT "partner_credit_award_disputes_decision_business_fk" FOREIGN KEY ("decision_id","business_id") REFERENCES "public"."partner_credit_award_decisions"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_corrections" ADD CONSTRAINT "partner_credit_corrections_proposed_by_users_id_fk" FOREIGN KEY ("proposed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_corrections" ADD CONSTRAINT "partner_credit_corrections_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_corrections" ADD CONSTRAINT "partner_credit_corrections_dispute_business_fk" FOREIGN KEY ("dispute_id","business_id") REFERENCES "public"."partner_credit_award_disputes"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_dispute_events" ADD CONSTRAINT "partner_credit_dispute_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_dispute_events" ADD CONSTRAINT "partner_credit_dispute_events_dispute_business_fk" FOREIGN KEY ("dispute_id","business_id") REFERENCES "public"."partner_credit_award_disputes"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "partner_credit_award_disputes_open_key" ON "partner_credit_award_disputes" USING btree ("decision_id") WHERE "partner_credit_award_disputes"."state" = 'open';--> statement-breakpoint
CREATE INDEX "partner_credit_award_disputes_decision_idx" ON "partner_credit_award_disputes" USING btree ("decision_id","state");--> statement-breakpoint
CREATE INDEX "partner_credit_dispute_events_dispute_idx" ON "partner_credit_dispute_events" USING btree ("dispute_id","seq");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION partner_credit_dispute_inert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Split 07 dispute and correction writes disabled pending financial activation authorization';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION partner_credit_dispute_events_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Split 07 dispute events are append-only';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION partner_credit_dispute_resolve_once()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  RAISE EXCEPTION 'Split 07 disputes and corrections are never deleted';
 END IF;
 IF TG_TABLE_NAME = 'partner_credit_award_disputes' THEN
  IF OLD.state <> 'open' THEN RAISE EXCEPTION 'Split 07 dispute already resolved'; END IF;
  IF NEW.id <> OLD.id OR NEW.business_id <> OLD.business_id OR NEW.decision_id <> OLD.decision_id OR NEW.opened_at <> OLD.opened_at THEN
   RAISE EXCEPTION 'Split 07 dispute identity is immutable';
  END IF;
 ELSE
  IF OLD.state <> 'proposed' THEN RAISE EXCEPTION 'Split 07 correction already decided'; END IF;
  IF NEW.id <> OLD.id OR NEW.dispute_id <> OLD.dispute_id OR NEW.business_id <> OLD.business_id OR NEW.kind <> OLD.kind
     OR NEW.units <> OLD.units OR NEW.proposed_by <> OLD.proposed_by OR NEW.proposed_at <> OLD.proposed_at THEN
   RAISE EXCEPTION 'Split 07 correction proposal is immutable';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_award_disputes_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_award_disputes FOR EACH ROW EXECUTE FUNCTION partner_credit_dispute_inert_guard();
--> statement-breakpoint
CREATE TRIGGER partner_credit_dispute_events_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_dispute_events FOR EACH ROW EXECUTE FUNCTION partner_credit_dispute_inert_guard();
--> statement-breakpoint
CREATE TRIGGER partner_credit_corrections_inert_guard BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_corrections FOR EACH ROW EXECUTE FUNCTION partner_credit_dispute_inert_guard();
--> statement-breakpoint
CREATE TRIGGER partner_credit_award_disputes_resolve_once BEFORE UPDATE OR DELETE ON partner_credit_award_disputes FOR EACH ROW EXECUTE FUNCTION partner_credit_dispute_resolve_once();
--> statement-breakpoint
CREATE TRIGGER partner_credit_corrections_resolve_once BEFORE UPDATE OR DELETE ON partner_credit_corrections FOR EACH ROW EXECUTE FUNCTION partner_credit_dispute_resolve_once();
--> statement-breakpoint
CREATE TRIGGER partner_credit_dispute_events_append_only BEFORE UPDATE OR DELETE ON partner_credit_dispute_events FOR EACH ROW EXECUTE FUNCTION partner_credit_dispute_events_append_only();
--> statement-breakpoint
CREATE TRIGGER partner_credit_dispute_events_no_truncate BEFORE TRUNCATE ON partner_credit_dispute_events FOR EACH STATEMENT EXECUTE FUNCTION partner_credit_dispute_events_append_only();
--> statement-breakpoint
CREATE TRIGGER partner_credit_award_disputes_no_truncate BEFORE TRUNCATE ON partner_credit_award_disputes FOR EACH STATEMENT EXECUTE FUNCTION partner_credit_dispute_events_append_only();
--> statement-breakpoint
CREATE TRIGGER partner_credit_corrections_no_truncate BEFORE TRUNCATE ON partner_credit_corrections FOR EACH STATEMENT EXECUTE FUNCTION partner_credit_dispute_events_append_only();
