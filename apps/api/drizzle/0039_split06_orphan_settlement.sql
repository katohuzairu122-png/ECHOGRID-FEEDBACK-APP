CREATE TABLE "orphan_reward_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"origin_business_id" uuid NOT NULL,
	"origin_membership_id" uuid,
	"origin_loyalty_account_id" uuid NOT NULL,
	"origin_loyalty_transaction_id" uuid NOT NULL,
	"origin_reward_id" uuid,
	"orphan_reason" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"source_reward_type" text NOT NULL,
	"source_reward_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"qualified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	CONSTRAINT "orphan_reward_claims_reason_check" CHECK ("orphan_reward_claims"."orphan_reason" IN ('origin_business_archived','platform_unable_to_honor')),
	CONSTRAINT "orphan_reward_claims_status_check" CHECK ("orphan_reward_claims"."status" IN ('available','reserved','settled','expired','reversed','cancelled')),
	CONSTRAINT "orphan_reward_claims_source_reward_type_check" CHECK ("orphan_reward_claims"."source_reward_type" IN ('discount','free_item','voucher')),
	CONSTRAINT "orphan_reward_claims_settled_at_check" CHECK ("orphan_reward_claims"."status" <> 'settled' OR "orphan_reward_claims"."settled_at" IS NOT NULL),
	CONSTRAINT "orphan_reward_claims_expired_at_check" CHECK ("orphan_reward_claims"."status" <> 'expired' OR "orphan_reward_claims"."expired_at" IS NOT NULL),
	CONSTRAINT "orphan_reward_claims_reversed_at_check" CHECK ("orphan_reward_claims"."status" <> 'reversed' OR "orphan_reward_claims"."reversed_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "orphan_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"receiving_business_id" uuid NOT NULL,
	"receiving_branch_id" uuid,
	"status" text DEFAULT 'proposed' NOT NULL,
	"access_authorization_id" uuid NOT NULL,
	"accepted_by_user_id" uuid,
	"accepted_at" timestamp with time zone,
	"completion_authorization_id" uuid,
	"completion_authorized_at" timestamp with time zone,
	"fulfilled_by_user_id" uuid,
	"fulfilled_at" timestamp with time zone,
	"fulfillment_policy_version" text,
	"fulfillment_snapshot" jsonb,
	"fulfillment_reference" text,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orphan_settlements_status_check" CHECK ("orphan_settlements"."status" IN ('proposed','accepted','reserved','completion_authorized','fulfilled','cancelled','expired','reversed')),
	CONSTRAINT "orphan_settlements_acceptance_check" CHECK ("orphan_settlements"."status" NOT IN ('accepted','reserved','completion_authorized','fulfilled')
        OR ("orphan_settlements"."accepted_by_user_id" IS NOT NULL AND "orphan_settlements"."accepted_at" IS NOT NULL)),
	CONSTRAINT "orphan_settlements_completion_authorization_check" CHECK ("orphan_settlements"."status" NOT IN ('completion_authorized','fulfilled')
        OR ("orphan_settlements"."completion_authorization_id" IS NOT NULL AND "orphan_settlements"."completion_authorized_at" IS NOT NULL)),
	CONSTRAINT "orphan_settlements_fulfillment_check" CHECK ("orphan_settlements"."status" <> 'fulfilled'
        OR ("orphan_settlements"."fulfilled_by_user_id" IS NOT NULL
          AND "orphan_settlements"."fulfilled_at" IS NOT NULL
          AND "orphan_settlements"."fulfillment_policy_version" IS NOT NULL
          AND "orphan_settlements"."fulfillment_snapshot" IS NOT NULL)),
	CONSTRAINT "orphan_settlements_expiry_check" CHECK ("orphan_settlements"."expires_at" > "orphan_settlements"."created_at")
);
--> statement-breakpoint
CREATE TABLE "orphan_settlement_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"settlement_id" uuid,
	"customer_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"origin_business_id" uuid NOT NULL,
	"receiving_business_id" uuid,
	"receiving_branch_id" uuid,
	"actor_user_id" uuid,
	"customer_action_authorization_id" uuid,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orphan_settlement_events_type_check" CHECK ("orphan_settlement_events"."event_type" IN ('orphan_created','partner_selected','partner_accepted','settlement_reserved','completion_authorized','settlement_fulfilled','settlement_expired','settlement_cancelled','settlement_reversed')),
	CONSTRAINT "orphan_settlement_events_branch_business_check" CHECK ("orphan_settlement_events"."receiving_branch_id" IS NULL OR "orphan_settlement_events"."receiving_business_id" IS NOT NULL),
	CONSTRAINT "orphan_settlement_events_settlement_required_check" CHECK ("orphan_settlement_events"."event_type" = 'orphan_created' OR "orphan_settlement_events"."settlement_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "orphan_reward_claims" ADD CONSTRAINT "orphan_reward_claims_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_reward_claims" ADD CONSTRAINT "orphan_reward_claims_origin_business_id_businesses_id_fk" FOREIGN KEY ("origin_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_reward_claims" ADD CONSTRAINT "orphan_reward_claims_origin_membership_id_business_customer_memberships_id_fk" FOREIGN KEY ("origin_membership_id") REFERENCES "public"."business_customer_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_reward_claims" ADD CONSTRAINT "orphan_reward_claims_origin_loyalty_account_id_loyalty_accounts_id_fk" FOREIGN KEY ("origin_loyalty_account_id") REFERENCES "public"."loyalty_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_reward_claims" ADD CONSTRAINT "orphan_reward_claims_origin_loyalty_transaction_id_loyalty_transactions_id_fk" FOREIGN KEY ("origin_loyalty_transaction_id") REFERENCES "public"."loyalty_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_reward_claims" ADD CONSTRAINT "orphan_reward_claims_origin_reward_id_loyalty_rewards_id_fk" FOREIGN KEY ("origin_reward_id") REFERENCES "public"."loyalty_rewards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_claim_id_orphan_reward_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."orphan_reward_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_receiving_business_id_businesses_id_fk" FOREIGN KEY ("receiving_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_receiving_branch_id_branches_id_fk" FOREIGN KEY ("receiving_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_access_authorization_id_customer_action_authorizations_id_fk" FOREIGN KEY ("access_authorization_id") REFERENCES "public"."customer_action_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_completion_authorization_id_customer_action_authorizations_id_fk" FOREIGN KEY ("completion_authorization_id") REFERENCES "public"."customer_action_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlements" ADD CONSTRAINT "orphan_settlements_fulfilled_by_user_id_users_id_fk" FOREIGN KEY ("fulfilled_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_claim_id_orphan_reward_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."orphan_reward_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_settlement_id_orphan_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."orphan_settlements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_origin_business_id_businesses_id_fk" FOREIGN KEY ("origin_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_receiving_business_id_businesses_id_fk" FOREIGN KEY ("receiving_business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_receiving_branch_id_branches_id_fk" FOREIGN KEY ("receiving_branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orphan_settlement_events" ADD CONSTRAINT "orphan_settlement_events_customer_action_authorization_id_customer_action_authorizations_id_fk" FOREIGN KEY ("customer_action_authorization_id") REFERENCES "public"."customer_action_authorizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orphan_reward_claims_source_transaction_key" ON "orphan_reward_claims" USING btree ("origin_loyalty_transaction_id");--> statement-breakpoint
CREATE INDEX "orphan_reward_claims_customer_status_idx" ON "orphan_reward_claims" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "orphan_reward_claims_origin_business_status_idx" ON "orphan_reward_claims" USING btree ("origin_business_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orphan_settlements_idempotency_key" ON "orphan_settlements" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "orphan_settlements_active_claim_key" ON "orphan_settlements" USING btree ("claim_id") WHERE "orphan_settlements"."status" IN ('accepted','reserved','completion_authorized');--> statement-breakpoint
CREATE INDEX "orphan_settlements_customer_status_idx" ON "orphan_settlements" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "orphan_settlements_receiving_business_status_idx" ON "orphan_settlements" USING btree ("receiving_business_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orphan_settlement_events_idempotency_key" ON "orphan_settlement_events" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "orphan_settlement_events_claim_created_idx" ON "orphan_settlement_events" USING btree ("claim_id","created_at");--> statement-breakpoint
CREATE INDEX "orphan_settlement_events_settlement_created_idx" ON "orphan_settlement_events" USING btree ("settlement_id","created_at");--> statement-breakpoint
CREATE INDEX "orphan_settlement_events_receiving_business_created_idx" ON "orphan_settlement_events" USING btree ("receiving_business_id","created_at");
