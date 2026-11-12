CREATE TABLE "customer_credentials" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"password_set_at" timestamp with time zone NOT NULL,
	"password_changed_at" timestamp with time zone NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"auth_method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"step_up_verified_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"device_label" text,
	"source_hint" text,
	CONSTRAINT "customer_sessions_auth_method_check" CHECK ("customer_sessions"."auth_method" IN ('otp', 'password', 'recovery')),
	CONSTRAINT "customer_sessions_revoked_reason_check" CHECK ("customer_sessions"."revoked_reason" IS NULL OR "customer_sessions"."revoked_reason" IN ('logout', 'logout_all', 'password_changed', 'recovery', 'replay_detected', 'suspended', 'expired_cleanup', 'admin')),
	CONSTRAINT "customer_sessions_revoked_pair_check" CHECK (("customer_sessions"."revoked_at" IS NULL) = ("customer_sessions"."revoked_reason" IS NULL)),
	CONSTRAINT "customer_sessions_device_label_length_check" CHECK ("customer_sessions"."device_label" IS NULL OR char_length("customer_sessions"."device_label") <= 80),
	CONSTRAINT "customer_sessions_source_hint_length_check" CHECK ("customer_sessions"."source_hint" IS NULL OR char_length("customer_sessions"."source_hint") <= 64)
);
--> statement-breakpoint
CREATE TABLE "customer_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"replaced_by_token_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "customer_refresh_tokens_hash_shape_check" CHECK ("customer_refresh_tokens"."token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "customer_auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid,
	"session_id" uuid,
	"event_type" text NOT NULL,
	"outcome" text NOT NULL,
	"reason_code" text,
	"subject_key" text,
	"source_hint" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_auth_events_event_type_check" CHECK ("customer_auth_events"."event_type" IN ('otp_requested', 'otp_verified', 'otp_failed', 'registration_completed', 'password_set', 'password_changed', 'password_login_succeeded', 'password_login_failed', 'recovery_started', 'recovery_completed', 'recovery_failed', 'session_created', 'session_refreshed', 'session_revoked', 'session_replay_detected', 'step_up_passed', 'step_up_failed', 'rate_limited', 'legacy_token_used', 'kill_switch_changed')),
	CONSTRAINT "customer_auth_events_outcome_check" CHECK ("customer_auth_events"."outcome" IN ('success', 'failure', 'blocked')),
	CONSTRAINT "customer_auth_events_reason_code_check" CHECK ("customer_auth_events"."reason_code" IS NULL OR "customer_auth_events"."reason_code" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "customer_auth_events_source_hint_length_check" CHECK ("customer_auth_events"."source_hint" IS NULL OR char_length("customer_auth_events"."source_hint") <= 64)
);
--> statement-breakpoint
ALTER TABLE "customer_credentials" ADD CONSTRAINT "customer_credentials_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_refresh_tokens" ADD CONSTRAINT "customer_refresh_tokens_session_id_customer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."customer_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_auth_events" ADD CONSTRAINT "customer_auth_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_sessions_customer_revoked_idx" ON "customer_sessions" USING btree ("customer_id","revoked_at");--> statement-breakpoint
CREATE INDEX "customer_sessions_absolute_expires_idx" ON "customer_sessions" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_refresh_tokens_token_hash_key" ON "customer_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "customer_refresh_tokens_session_idx" ON "customer_refresh_tokens" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "customer_refresh_tokens_expires_idx" ON "customer_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "customer_auth_events_customer_created_idx" ON "customer_auth_events" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_auth_events_type_created_idx" ON "customer_auth_events" USING btree ("event_type","created_at");