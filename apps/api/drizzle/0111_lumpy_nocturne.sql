CREATE TABLE "b2b_abuse_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_business_id" uuid NOT NULL,
	"reporter_user_id" uuid NOT NULL,
	"target_business_id" uuid NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_abuse_reports_not_self" CHECK ("b2b_abuse_reports"."reporter_business_id" <> "b2b_abuse_reports"."target_business_id"),
	CONSTRAINT "b2b_abuse_reports_resource_valid" CHECK ("b2b_abuse_reports"."resource_type" IN ('business','request','partnership','message','proposal')),
	CONSTRAINT "b2b_abuse_reports_reason_valid" CHECK ("b2b_abuse_reports"."reason_code" IN ('spam','harassment','misrepresentation','unauthorized_content','other')),
	CONSTRAINT "b2b_abuse_reports_status_valid" CHECK ("b2b_abuse_reports"."status" IN ('open','reviewing','resolved','dismissed')),
	CONSTRAINT "b2b_abuse_reports_details_length" CHECK ("b2b_abuse_reports"."details" IS NULL OR char_length("b2b_abuse_reports"."details") <= 1000)
);
--> statement-breakpoint
CREATE TABLE "b2b_message_reads" (
	"message_id" uuid NOT NULL,
	"partnership_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "b2b_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partnership_id" uuid NOT NULL,
	"sender_business_id" uuid NOT NULL,
	"sender_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_messages_body_length" CHECK (char_length(btrim("b2b_messages"."body")) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
CREATE TABLE "b2b_moderation_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_business_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason" text NOT NULL,
	"related_report_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_moderation_actions_type_valid" CHECK ("b2b_moderation_actions"."action_type" IN ('restrict_participation','restore_participation','suspend_partnership','reinstate_partnership')),
	CONSTRAINT "b2b_moderation_actions_reason_code_valid" CHECK ("b2b_moderation_actions"."reason_code" ~ '^[A-Z_]{3,40}$'),
	CONSTRAINT "b2b_moderation_actions_reason_length" CHECK (char_length(btrim("b2b_moderation_actions"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "b2b_notification_reads" (
	"notification_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "b2b_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_business_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_notifications_event_type_valid" CHECK ("b2b_notifications"."event_type" IN ('request_received','request_accepted','request_rejected','request_cancelled','request_expired','partnership_established','partnership_terminated','message_received','proposal_received','proposal_responded','moderation_action')),
	CONSTRAINT "b2b_notifications_resource_type_valid" CHECK ("b2b_notifications"."resource_type" IN ('request','partnership','message','proposal','moderation')),
	CONSTRAINT "b2b_notifications_subject_length" CHECK (char_length(btrim("b2b_notifications"."subject")) BETWEEN 1 AND 120),
	CONSTRAINT "b2b_notifications_body_length" CHECK (char_length(btrim("b2b_notifications"."body")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "b2b_proposal_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_business_id" uuid,
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_proposal_events_type_valid" CHECK ("b2b_proposal_events"."event_type" IN ('created','accepted','declined','withdrawn')),
	CONSTRAINT "b2b_proposal_events_actor_pair" CHECK (("b2b_proposal_events"."actor_business_id" IS NULL) = ("b2b_proposal_events"."actor_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "b2b_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partnership_id" uuid NOT NULL,
	"proposer_business_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"responded_by_user_id" uuid,
	"responded_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_proposals_status_valid" CHECK ("b2b_proposals"."status" IN ('pending','accepted','declined','withdrawn')),
	CONSTRAINT "b2b_proposals_title_length" CHECK (char_length(btrim("b2b_proposals"."title")) BETWEEN 1 AND 120),
	CONSTRAINT "b2b_proposals_description_length" CHECK (char_length(btrim("b2b_proposals"."description")) BETWEEN 1 AND 2000),
	CONSTRAINT "b2b_proposals_response_evidence" CHECK (("b2b_proposals"."status" = 'accepted' OR "b2b_proposals"."status" = 'declined') = ("b2b_proposals"."responded_at" IS NOT NULL AND "b2b_proposals"."responded_by_user_id" IS NOT NULL)),
	CONSTRAINT "b2b_proposals_withdrawn_evidence" CHECK (("b2b_proposals"."status" = 'withdrawn') = ("b2b_proposals"."withdrawn_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "b2b_abuse_reports" ADD CONSTRAINT "b2b_abuse_reports_reporter_business_id_businesses_id_fk" FOREIGN KEY ("reporter_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_abuse_reports" ADD CONSTRAINT "b2b_abuse_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_abuse_reports" ADD CONSTRAINT "b2b_abuse_reports_target_business_id_businesses_id_fk" FOREIGN KEY ("target_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_message_reads" ADD CONSTRAINT "b2b_message_reads_message_id_b2b_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."b2b_messages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_message_reads" ADD CONSTRAINT "b2b_message_reads_partnership_id_b2b_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."b2b_partnerships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_message_reads" ADD CONSTRAINT "b2b_message_reads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_message_reads" ADD CONSTRAINT "b2b_message_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_messages" ADD CONSTRAINT "b2b_messages_partnership_id_b2b_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."b2b_partnerships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_messages" ADD CONSTRAINT "b2b_messages_sender_business_id_businesses_id_fk" FOREIGN KEY ("sender_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_messages" ADD CONSTRAINT "b2b_messages_sender_user_id_users_id_fk" FOREIGN KEY ("sender_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_moderation_actions" ADD CONSTRAINT "b2b_moderation_actions_target_business_id_businesses_id_fk" FOREIGN KEY ("target_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_moderation_actions" ADD CONSTRAINT "b2b_moderation_actions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_moderation_actions" ADD CONSTRAINT "b2b_moderation_actions_related_report_id_b2b_abuse_reports_id_fk" FOREIGN KEY ("related_report_id") REFERENCES "public"."b2b_abuse_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_notification_reads" ADD CONSTRAINT "b2b_notification_reads_notification_id_b2b_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."b2b_notifications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_notification_reads" ADD CONSTRAINT "b2b_notification_reads_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_notification_reads" ADD CONSTRAINT "b2b_notification_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_notifications" ADD CONSTRAINT "b2b_notifications_recipient_business_id_businesses_id_fk" FOREIGN KEY ("recipient_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposal_events" ADD CONSTRAINT "b2b_proposal_events_proposal_id_b2b_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."b2b_proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposal_events" ADD CONSTRAINT "b2b_proposal_events_actor_business_id_businesses_id_fk" FOREIGN KEY ("actor_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposal_events" ADD CONSTRAINT "b2b_proposal_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposals" ADD CONSTRAINT "b2b_proposals_partnership_id_b2b_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."b2b_partnerships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposals" ADD CONSTRAINT "b2b_proposals_proposer_business_id_businesses_id_fk" FOREIGN KEY ("proposer_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposals" ADD CONSTRAINT "b2b_proposals_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_proposals" ADD CONSTRAINT "b2b_proposals_responded_by_user_id_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "b2b_abuse_reports_open_idx" ON "b2b_abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "b2b_abuse_reports_reporter_idx" ON "b2b_abuse_reports" USING btree ("reporter_business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_message_reads_once_uq" ON "b2b_message_reads" USING btree ("message_id","user_id");--> statement-breakpoint
CREATE INDEX "b2b_message_reads_unread_idx" ON "b2b_message_reads" USING btree ("partnership_id","business_id","user_id");--> statement-breakpoint
CREATE INDEX "b2b_messages_conversation_idx" ON "b2b_messages" USING btree ("partnership_id","created_at","id");--> statement-breakpoint
CREATE INDEX "b2b_moderation_actions_business_idx" ON "b2b_moderation_actions" USING btree ("target_business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_notification_reads_once_uq" ON "b2b_notification_reads" USING btree ("notification_id","user_id");--> statement-breakpoint
CREATE INDEX "b2b_notification_reads_business_idx" ON "b2b_notification_reads" USING btree ("business_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_notifications_event_key_uq" ON "b2b_notifications" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "b2b_notifications_recipient_created_idx" ON "b2b_notifications" USING btree ("recipient_business_id","created_at");--> statement-breakpoint
CREATE INDEX "b2b_proposal_events_proposal_idx" ON "b2b_proposal_events" USING btree ("proposal_id","created_at");--> statement-breakpoint
CREATE INDEX "b2b_proposals_partnership_idx" ON "b2b_proposals" USING btree ("partnership_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_append_only_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'B2B_APPEND_ONLY (% on %)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'B2B_NO_TRUNCATE (%)', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_request_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'B2B_REQUEST_HISTORY_PRESERVED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.requester_business_id <> OLD.requester_business_id OR NEW.target_business_id <> OLD.target_business_id
      OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.reason <> OLD.reason
      OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at OR NEW.expires_at <> OLD.expires_at THEN
      RAISE EXCEPTION 'B2B_REQUEST_IDENTITY_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status = 'pending' AND NEW.status IN ('accepted','rejected','cancelled','expired')) THEN
      RAISE EXCEPTION 'B2B_REQUEST_BAD_TRANSITION (% to %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status <> 'pending' AND NEW.status = OLD.status AND (NEW.responded_at IS DISTINCT FROM OLD.responded_at
      OR NEW.responded_by_user_id IS DISTINCT FROM OLD.responded_by_user_id OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
      OR NEW.cancelled_by_user_id IS DISTINCT FROM OLD.cancelled_by_user_id OR NEW.response_note IS DISTINCT FROM OLD.response_note) THEN
      RAISE EXCEPTION 'B2B_REQUEST_TERMINAL_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER b2b_requests_lifecycle_guard BEFORE UPDATE OR DELETE ON b2b_partnership_requests FOR EACH ROW EXECUTE FUNCTION b2b_request_lifecycle_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_partnership_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'B2B_PARTNERSHIP_HISTORY_PRESERVED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.source_request_id <> OLD.source_request_id OR NEW.business_a_id <> OLD.business_a_id OR NEW.business_b_id <> OLD.business_b_id OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'B2B_PARTNERSHIP_IDENTITY_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT ((OLD.status = 'active' AND NEW.status IN ('suspended','terminated')) OR (OLD.status = 'suspended' AND NEW.status IN ('active','terminated'))) THEN
      RAISE EXCEPTION 'B2B_PARTNERSHIP_BAD_TRANSITION (% to %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'terminated' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'B2B_PARTNERSHIP_TERMINAL_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM b2b_partnership_requests r WHERE r.id = NEW.source_request_id AND r.status = 'accepted'
      AND LEAST(r.requester_business_id,r.target_business_id) = NEW.business_a_id
      AND GREATEST(r.requester_business_id,r.target_business_id) = NEW.business_b_id
  ) THEN RAISE EXCEPTION 'B2B_PARTNERSHIP_REQUIRES_ACCEPTED_REQUEST' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER b2b_partnerships_lifecycle_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_partnerships FOR EACH ROW EXECUTE FUNCTION b2b_partnership_lifecycle_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_message_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'B2B_MESSAGE_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM b2b_partnerships p WHERE p.id=NEW.partnership_id AND p.status='active'
    AND NEW.sender_business_id IN (p.business_a_id,p.business_b_id)) THEN
    RAISE EXCEPTION 'B2B_MESSAGE_REQUIRES_ACTIVE_PARTNERSHIP' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER b2b_messages_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_messages FOR EACH ROW EXECUTE FUNCTION b2b_message_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_proposal_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'B2B_PROPOSAL_HISTORY_PRESERVED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM b2b_partnerships p WHERE p.id=NEW.partnership_id AND p.status='active' AND NEW.proposer_business_id IN (p.business_a_id,p.business_b_id)) THEN
      RAISE EXCEPTION 'B2B_PROPOSAL_REQUIRES_ACTIVE_PARTNERSHIP' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF NEW.partnership_id <> OLD.partnership_id OR NEW.proposer_business_id <> OLD.proposer_business_id OR NEW.created_by_user_id <> OLD.created_by_user_id
      OR NEW.title <> OLD.title OR NEW.description <> OLD.description OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'B2B_PROPOSAL_CONTENT_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status='pending' AND NEW.status IN ('accepted','declined','withdrawn')) THEN
      RAISE EXCEPTION 'B2B_PROPOSAL_BAD_TRANSITION' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER b2b_proposals_guard BEFORE INSERT OR UPDATE OR DELETE ON b2b_proposals FOR EACH ROW EXECUTE FUNCTION b2b_proposal_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_request_events_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_partnership_request_events FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_partnership_events_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_partnership_events FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_proposal_events_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_proposal_events FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_moderation_actions_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_moderation_actions FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_messages_no_truncate BEFORE TRUNCATE ON b2b_messages FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_requests_no_truncate BEFORE TRUNCATE ON b2b_partnership_requests FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_partnerships_no_truncate BEFORE TRUNCATE ON b2b_partnerships FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
ALTER TABLE b2b_partnership_requests ENABLE ALWAYS TRIGGER b2b_requests_lifecycle_guard;
--> statement-breakpoint
ALTER TABLE b2b_partnership_events ENABLE ALWAYS TRIGGER b2b_partnership_events_append_only;
--> statement-breakpoint
ALTER TABLE b2b_partnership_request_events ENABLE ALWAYS TRIGGER b2b_request_events_append_only;
--> statement-breakpoint
ALTER TABLE b2b_proposal_events ENABLE ALWAYS TRIGGER b2b_proposal_events_append_only;
--> statement-breakpoint
ALTER TABLE b2b_moderation_actions ENABLE ALWAYS TRIGGER b2b_moderation_actions_append_only;
--> statement-breakpoint
ALTER TABLE b2b_messages ENABLE ALWAYS TRIGGER b2b_messages_guard;
--> statement-breakpoint
ALTER TABLE b2b_proposals ENABLE ALWAYS TRIGGER b2b_proposals_guard;
--> statement-breakpoint
ALTER TABLE b2b_messages ENABLE ALWAYS TRIGGER b2b_messages_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_partnership_requests ENABLE ALWAYS TRIGGER b2b_requests_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_partnerships ENABLE ALWAYS TRIGGER b2b_partnerships_no_truncate;
--> statement-breakpoint
CREATE TRIGGER b2b_notifications_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_notifications FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_notification_reads_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_notification_reads FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_message_reads_append_only BEFORE INSERT OR UPDATE OR DELETE ON b2b_message_reads FOR EACH ROW EXECUTE FUNCTION b2b_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER b2b_notifications_no_truncate BEFORE TRUNCATE ON b2b_notifications FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_notification_reads_no_truncate BEFORE TRUNCATE ON b2b_notification_reads FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_message_reads_no_truncate BEFORE TRUNCATE ON b2b_message_reads FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_proposals_no_truncate BEFORE TRUNCATE ON b2b_proposals FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_proposal_events_no_truncate BEFORE TRUNCATE ON b2b_proposal_events FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_moderation_actions_no_truncate BEFORE TRUNCATE ON b2b_moderation_actions FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_abuse_reports_no_truncate BEFORE TRUNCATE ON b2b_abuse_reports FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
ALTER TABLE b2b_notifications ENABLE ALWAYS TRIGGER b2b_notifications_append_only;
--> statement-breakpoint
ALTER TABLE b2b_notification_reads ENABLE ALWAYS TRIGGER b2b_notification_reads_append_only;
--> statement-breakpoint
ALTER TABLE b2b_message_reads ENABLE ALWAYS TRIGGER b2b_message_reads_append_only;
--> statement-breakpoint
ALTER TABLE b2b_notifications ENABLE ALWAYS TRIGGER b2b_notifications_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_notification_reads ENABLE ALWAYS TRIGGER b2b_notification_reads_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_message_reads ENABLE ALWAYS TRIGGER b2b_message_reads_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_proposals ENABLE ALWAYS TRIGGER b2b_proposals_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_proposal_events ENABLE ALWAYS TRIGGER b2b_proposal_events_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_moderation_actions ENABLE ALWAYS TRIGGER b2b_moderation_actions_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_abuse_reports ENABLE ALWAYS TRIGGER b2b_abuse_reports_no_truncate;
--> statement-breakpoint
CREATE TRIGGER b2b_request_events_no_truncate BEFORE TRUNCATE ON b2b_partnership_request_events FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
CREATE TRIGGER b2b_partnership_events_no_truncate BEFORE TRUNCATE ON b2b_partnership_events FOR EACH STATEMENT EXECUTE FUNCTION b2b_no_truncate();
--> statement-breakpoint
ALTER TABLE b2b_partnership_request_events ENABLE ALWAYS TRIGGER b2b_request_events_no_truncate;
--> statement-breakpoint
ALTER TABLE b2b_partnership_events ENABLE ALWAYS TRIGGER b2b_partnership_events_no_truncate;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION b2b_abuse_report_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'B2B_REPORT_HISTORY_PRESERVED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.reporter_business_id <> OLD.reporter_business_id OR NEW.reporter_user_id <> OLD.reporter_user_id
      OR NEW.target_business_id <> OLD.target_business_id OR NEW.resource_type <> OLD.resource_type
      OR NEW.resource_id <> OLD.resource_id OR NEW.reason_code <> OLD.reason_code
      OR NEW.details IS DISTINCT FROM OLD.details OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'B2B_REPORT_CONTENT_IMMUTABLE' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.status <> OLD.status AND NOT (OLD.status IN ('open','reviewing') AND NEW.status IN ('reviewing','resolved','dismissed')) THEN
      RAISE EXCEPTION 'B2B_REPORT_BAD_TRANSITION (% to %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER b2b_abuse_reports_guard BEFORE UPDATE OR DELETE ON b2b_abuse_reports FOR EACH ROW EXECUTE FUNCTION b2b_abuse_report_guard();
--> statement-breakpoint
ALTER TABLE b2b_abuse_reports ENABLE ALWAYS TRIGGER b2b_abuse_reports_guard;
