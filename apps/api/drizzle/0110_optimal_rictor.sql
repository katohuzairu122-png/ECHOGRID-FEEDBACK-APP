CREATE TABLE "b2b_partnership_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"partnership_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_business_id" uuid,
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_partnership_events_type_valid" CHECK ("b2b_partnership_events"."event_type" IN ('established','suspended','reinstated','terminated')),
	CONSTRAINT "b2b_partnership_events_actor_pair" CHECK (("b2b_partnership_events"."actor_business_id" IS NULL) = ("b2b_partnership_events"."actor_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "b2b_partnership_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"actor_business_id" uuid,
	"actor_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_request_events_type_valid" CHECK ("b2b_partnership_request_events"."event_type" IN ('created','accepted','rejected','cancelled','expired')),
	CONSTRAINT "b2b_request_events_actor_pair" CHECK (("b2b_partnership_request_events"."actor_business_id" IS NULL) = ("b2b_partnership_request_events"."actor_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "b2b_partnership_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_business_id" uuid NOT NULL,
	"target_business_id" uuid NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"responded_by_user_id" uuid,
	"response_note" text,
	"cancelled_at" timestamp with time zone,
	"cancelled_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "b2b_partnership_requests_distinct_businesses" CHECK ("b2b_partnership_requests"."requester_business_id" <> "b2b_partnership_requests"."target_business_id"),
	CONSTRAINT "b2b_partnership_requests_status_valid" CHECK ("b2b_partnership_requests"."status" IN ('pending','accepted','rejected','cancelled','expired')),
	CONSTRAINT "b2b_partnership_requests_reason_length" CHECK (char_length(btrim("b2b_partnership_requests"."reason")) BETWEEN 1 AND 1000),
	CONSTRAINT "b2b_partnership_requests_idempotency_format" CHECK ("b2b_partnership_requests"."idempotency_key" ~ '^[A-Za-z0-9._:-]{8,128}$'),
	CONSTRAINT "b2b_partnership_requests_response_state" CHECK (("b2b_partnership_requests"."status" IN ('accepted','rejected')) = ("b2b_partnership_requests"."responded_at" IS NOT NULL AND "b2b_partnership_requests"."responded_by_user_id" IS NOT NULL)),
	CONSTRAINT "b2b_partnership_requests_cancelled_state" CHECK (("b2b_partnership_requests"."status" = 'cancelled') = ("b2b_partnership_requests"."cancelled_at" IS NOT NULL AND "b2b_partnership_requests"."cancelled_by_user_id" IS NOT NULL)),
	CONSTRAINT "b2b_partnership_requests_response_note_length" CHECK ("b2b_partnership_requests"."response_note" IS NULL OR char_length("b2b_partnership_requests"."response_note") <= 500)
);
--> statement-breakpoint
CREATE TABLE "b2b_partnerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_request_id" uuid NOT NULL,
	"business_a_id" uuid NOT NULL,
	"business_b_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_by_user_id" uuid,
	"suspension_reason" text,
	"terminated_at" timestamp with time zone,
	"terminated_by_business_id" uuid,
	"terminated_by_user_id" uuid,
	CONSTRAINT "b2b_partnerships_source_request_id_unique" UNIQUE("source_request_id"),
	CONSTRAINT "b2b_partnerships_pair_ordered" CHECK ("b2b_partnerships"."business_a_id" < "b2b_partnerships"."business_b_id"),
	CONSTRAINT "b2b_partnerships_status_valid" CHECK ("b2b_partnerships"."status" IN ('active','suspended','terminated')),
	CONSTRAINT "b2b_partnerships_suspension_evidence" CHECK (("b2b_partnerships"."status" = 'suspended') = ("b2b_partnerships"."suspended_at" IS NOT NULL AND "b2b_partnerships"."suspended_by_user_id" IS NOT NULL AND "b2b_partnerships"."suspension_reason" IS NOT NULL)),
	CONSTRAINT "b2b_partnerships_termination_evidence" CHECK (("b2b_partnerships"."status" = 'terminated') = ("b2b_partnerships"."terminated_at" IS NOT NULL AND "b2b_partnerships"."terminated_by_business_id" IS NOT NULL AND "b2b_partnerships"."terminated_by_user_id" IS NOT NULL)),
	CONSTRAINT "b2b_partnerships_suspension_reason_length" CHECK ("b2b_partnerships"."suspension_reason" IS NULL OR char_length(btrim("b2b_partnerships"."suspension_reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "b2b_partnership_events" ADD CONSTRAINT "b2b_partnership_events_partnership_id_b2b_partnerships_id_fk" FOREIGN KEY ("partnership_id") REFERENCES "public"."b2b_partnerships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_events" ADD CONSTRAINT "b2b_partnership_events_actor_business_id_businesses_id_fk" FOREIGN KEY ("actor_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_events" ADD CONSTRAINT "b2b_partnership_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_request_events" ADD CONSTRAINT "b2b_partnership_request_events_request_id_b2b_partnership_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."b2b_partnership_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_request_events" ADD CONSTRAINT "b2b_partnership_request_events_actor_business_id_businesses_id_fk" FOREIGN KEY ("actor_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_request_events" ADD CONSTRAINT "b2b_partnership_request_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_requests" ADD CONSTRAINT "b2b_partnership_requests_requester_business_id_businesses_id_fk" FOREIGN KEY ("requester_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_requests" ADD CONSTRAINT "b2b_partnership_requests_target_business_id_businesses_id_fk" FOREIGN KEY ("target_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_requests" ADD CONSTRAINT "b2b_partnership_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_requests" ADD CONSTRAINT "b2b_partnership_requests_responded_by_user_id_users_id_fk" FOREIGN KEY ("responded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnership_requests" ADD CONSTRAINT "b2b_partnership_requests_cancelled_by_user_id_users_id_fk" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnerships" ADD CONSTRAINT "b2b_partnerships_source_request_id_b2b_partnership_requests_id_fk" FOREIGN KEY ("source_request_id") REFERENCES "public"."b2b_partnership_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnerships" ADD CONSTRAINT "b2b_partnerships_business_a_id_businesses_id_fk" FOREIGN KEY ("business_a_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnerships" ADD CONSTRAINT "b2b_partnerships_business_b_id_businesses_id_fk" FOREIGN KEY ("business_b_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnerships" ADD CONSTRAINT "b2b_partnerships_suspended_by_user_id_users_id_fk" FOREIGN KEY ("suspended_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnerships" ADD CONSTRAINT "b2b_partnerships_terminated_by_business_id_businesses_id_fk" FOREIGN KEY ("terminated_by_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "b2b_partnerships" ADD CONSTRAINT "b2b_partnerships_terminated_by_user_id_users_id_fk" FOREIGN KEY ("terminated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "b2b_partnership_events_partnership_idx" ON "b2b_partnership_events" USING btree ("partnership_id","created_at");--> statement-breakpoint
CREATE INDEX "b2b_request_events_request_idx" ON "b2b_partnership_request_events" USING btree ("request_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_partnership_requests_idempotency_uq" ON "b2b_partnership_requests" USING btree ("requester_business_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_partnership_requests_one_pending_pair_uq" ON "b2b_partnership_requests" USING btree (LEAST("requester_business_id", "target_business_id"),GREATEST("requester_business_id", "target_business_id")) WHERE "b2b_partnership_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "b2b_partnership_requests_sender_day_idx" ON "b2b_partnership_requests" USING btree ("requester_business_id","created_at");--> statement-breakpoint
CREATE INDEX "b2b_partnership_requests_target_idx" ON "b2b_partnership_requests" USING btree ("target_business_id","status","created_at");--> statement-breakpoint
CREATE INDEX "b2b_partnership_requests_cooldown_idx" ON "b2b_partnership_requests" USING btree ("requester_business_id","target_business_id","responded_at") WHERE "b2b_partnership_requests"."status" = 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "b2b_partnerships_one_live_pair_uq" ON "b2b_partnerships" USING btree ("business_a_id","business_b_id") WHERE "b2b_partnerships"."status" IN ('active','suspended');--> statement-breakpoint
CREATE INDEX "b2b_partnerships_business_a_idx" ON "b2b_partnerships" USING btree ("business_a_id","status","created_at");--> statement-breakpoint
CREATE INDEX "b2b_partnerships_business_b_idx" ON "b2b_partnerships" USING btree ("business_b_id","status","created_at");