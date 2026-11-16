CREATE TABLE "customer_recovery_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'awaiting_factors' NOT NULL,
	"risk" text,
	"risk_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"email_factor_at" timestamp with time zone,
	"phone_factor_at" timestamp with time zone,
	"phone_proof_verified_at" timestamp with time zone,
	"code_factor_at" timestamp with time zone,
	"factor_failures" integer DEFAULT 0 NOT NULL,
	"notice_accepted_at" timestamp with time zone,
	"hold_started_at" timestamp with time zone,
	"hold_until" timestamp with time zone,
	"hold_notice_accepted_at" timestamp with time zone,
	"cancel_digest" text NOT NULL,
	"cancel_expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ended_reason" text,
	CONSTRAINT "customer_recovery_attempts_status_check" CHECK ("customer_recovery_attempts"."status" IN ('awaiting_factors', 'factors_verified', 'security_hold', 'cancelled', 'expired', 'completed', 'rejected')),
	CONSTRAINT "customer_recovery_attempts_risk_check" CHECK ("customer_recovery_attempts"."risk" IS NULL OR "customer_recovery_attempts"."risk" IN ('standard', 'high')),
	CONSTRAINT "customer_recovery_attempts_risk_reason_check" CHECK ("customer_recovery_attempts"."risk_reason" IS NULL OR "customer_recovery_attempts"."risk_reason" IN ('both_factors', 'recovery_code_path', 'recent_phone_verification')),
	CONSTRAINT "customer_recovery_attempts_ended_reason_check" CHECK ("customer_recovery_attempts"."ended_reason" IS NULL OR "customer_recovery_attempts"."ended_reason" IN ('completed', 'cancelled_by_customer', 'expired', 'superseded', 'notification_failed', 'factor_budget_exhausted')),
	CONSTRAINT "customer_recovery_attempts_terminal_check" CHECK (("customer_recovery_attempts"."status" IN ('cancelled', 'expired', 'completed', 'rejected')) = ("customer_recovery_attempts"."ended_at" IS NOT NULL)),
	CONSTRAINT "customer_recovery_attempts_ended_reason_presence_check" CHECK (("customer_recovery_attempts"."ended_at" IS NULL) = ("customer_recovery_attempts"."ended_reason" IS NULL)),
	CONSTRAINT "customer_recovery_attempts_failures_check" CHECK ("customer_recovery_attempts"."factor_failures" >= 0 AND "customer_recovery_attempts"."factor_failures" <= 5),
	CONSTRAINT "customer_recovery_attempts_phone_evidence_check" CHECK (("customer_recovery_attempts"."phone_factor_at" IS NULL) = ("customer_recovery_attempts"."phone_proof_verified_at" IS NULL)),
	CONSTRAINT "customer_recovery_attempts_two_factor_check" CHECK ("customer_recovery_attempts"."status" NOT IN ('factors_verified', 'security_hold', 'completed') OR num_nonnulls("customer_recovery_attempts"."email_factor_at", "customer_recovery_attempts"."phone_factor_at", "customer_recovery_attempts"."code_factor_at") >= 2),
	CONSTRAINT "customer_recovery_attempts_risk_required_check" CHECK ("customer_recovery_attempts"."status" NOT IN ('factors_verified', 'security_hold', 'completed') OR "customer_recovery_attempts"."risk" IS NOT NULL),
	CONSTRAINT "customer_recovery_attempts_hold_check" CHECK (("customer_recovery_attempts"."hold_until" IS NULL) = ("customer_recovery_attempts"."hold_started_at" IS NULL) AND ("customer_recovery_attempts"."hold_until" IS NULL OR ("customer_recovery_attempts"."risk" = 'high' AND "customer_recovery_attempts"."hold_until" > "customer_recovery_attempts"."hold_started_at")) AND ("customer_recovery_attempts"."status" <> 'security_hold' OR "customer_recovery_attempts"."hold_until" IS NOT NULL)),
	CONSTRAINT "customer_recovery_attempts_completed_check" CHECK ("customer_recovery_attempts"."status" <> 'completed' OR ("customer_recovery_attempts"."notice_accepted_at" IS NOT NULL AND ("customer_recovery_attempts"."risk" = 'standard' OR ("customer_recovery_attempts"."hold_notice_accepted_at" IS NOT NULL AND "customer_recovery_attempts"."ended_at" >= "customer_recovery_attempts"."hold_until")))),
	CONSTRAINT "customer_recovery_attempts_digest_check" CHECK ("customer_recovery_attempts"."cancel_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "customer_recovery_attempts_expiry_check" CHECK ("customer_recovery_attempts"."expires_at" > "customer_recovery_attempts"."created_at" AND "customer_recovery_attempts"."cancel_expires_at" > "customer_recovery_attempts"."created_at")
);
--> statement-breakpoint
ALTER TABLE "customer_auth_events" DROP CONSTRAINT "customer_auth_events_event_type_check";--> statement-breakpoint
ALTER TABLE "customer_recovery_attempts" ADD CONSTRAINT "customer_recovery_attempts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recovery_attempts_active_customer_uidx" ON "customer_recovery_attempts" USING btree ("customer_id") WHERE "customer_recovery_attempts"."status" IN ('awaiting_factors', 'factors_verified', 'security_hold');--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recovery_attempts_phone_proof_uidx" ON "customer_recovery_attempts" USING btree ("customer_id","phone_proof_verified_at") WHERE "customer_recovery_attempts"."phone_proof_verified_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_recovery_attempts_cancel_digest_uidx" ON "customer_recovery_attempts" USING btree ("cancel_digest");--> statement-breakpoint
CREATE INDEX "customer_recovery_attempts_customer_created_idx" ON "customer_recovery_attempts" USING btree ("customer_id","created_at");--> statement-breakpoint
ALTER TABLE "customer_auth_events" ADD CONSTRAINT "customer_auth_events_event_type_check" CHECK ("customer_auth_events"."event_type" IN ('otp_requested', 'otp_verified', 'otp_failed', 'registration_completed', 'password_set', 'password_changed', 'password_login_succeeded', 'password_login_failed', 'recovery_started', 'recovery_completed', 'recovery_failed', 'session_created', 'session_refreshed', 'session_revoked', 'session_replay_detected', 'step_up_passed', 'step_up_failed', 'rate_limited', 'legacy_token_used', 'kill_switch_changed', 'recovery_code_issued', 'recovery_code_redeemed', 'recovery_code_failed', 'recovery_code_revoked', 'recovery_factor_verified', 'recovery_hold_started', 'recovery_cancelled'));