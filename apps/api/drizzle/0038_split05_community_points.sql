CREATE TABLE "community_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"policy_version" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_memberships_status_check" CHECK ("community_memberships"."status" IN ('active','left','suspended')),
	CONSTRAINT "community_memberships_left_at_check" CHECK ("community_memberships"."status" <> 'left' OR "community_memberships"."left_at" IS NOT NULL),
	CONSTRAINT "community_memberships_suspended_at_check" CHECK ("community_memberships"."status" <> 'suspended' OR "community_memberships"."suspended_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "community_point_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"points_balance" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_point_accounts_status_check" CHECK ("community_point_accounts"."status" IN ('active','suspended','closed'))
);
--> statement-breakpoint
CREATE TABLE "community_point_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"points" integer NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "community_point_rules_source_type_check" CHECK ("community_point_rules"."source_type" IN ('survey_completion')),
	CONSTRAINT "community_point_rules_resource_type_check" CHECK ("community_point_rules"."resource_type" IS NULL OR "community_point_rules"."resource_type" IN ('survey_campaign')),
	CONSTRAINT "community_point_rules_resource_pair_check" CHECK (("community_point_rules"."resource_type" IS NULL) = ("community_point_rules"."resource_id" IS NULL)),
	CONSTRAINT "community_point_rules_status_check" CHECK ("community_point_rules"."status" IN ('draft','active','paused','retired')),
	CONSTRAINT "community_point_rules_version_check" CHECK ("community_point_rules"."version" > 0),
	CONSTRAINT "community_point_rules_points_check" CHECK ("community_point_rules"."points" > 0),
	CONSTRAINT "community_point_rules_window_check" CHECK ("community_point_rules"."starts_at" IS NULL OR "community_point_rules"."ends_at" IS NULL OR "community_point_rules"."ends_at" > "community_point_rules"."starts_at"),
	CONSTRAINT "community_point_rules_activation_check" CHECK ("community_point_rules"."status" <> 'active' OR "community_point_rules"."activated_at" IS NOT NULL),
	CONSTRAINT "community_point_rules_retirement_check" CHECK ("community_point_rules"."status" <> 'retired' OR "community_point_rules"."retired_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "community_point_award_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"account_id" uuid,
	"source_type" text NOT NULL,
	"source_ref" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"status" text NOT NULL,
	"points" integer NOT NULL,
	"reason_code" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"awarded_transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "community_point_award_decisions_source_type_check" CHECK ("community_point_award_decisions"."source_type" IN ('survey_completion')),
	CONSTRAINT "community_point_award_decisions_status_check" CHECK ("community_point_award_decisions"."status" IN ('pending_membership','awarded','rejected','reversed')),
	CONSTRAINT "community_point_award_decisions_points_check" CHECK ("community_point_award_decisions"."points" > 0),
	CONSTRAINT "community_point_award_decisions_awarded_account_check" CHECK ("community_point_award_decisions"."status" NOT IN ('awarded','reversed') OR "community_point_award_decisions"."account_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "community_point_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"type" text NOT NULL,
	"points" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_ref" text,
	"rule_id" uuid,
	"award_decision_id" uuid,
	"business_id" uuid,
	"branch_id" uuid,
	"reversal_of" uuid,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "community_point_transactions_type_check" CHECK ("community_point_transactions"."type" IN ('earn','redeem','reverse','expire','admin_adjustment')),
	CONSTRAINT "community_point_transactions_source_type_check" CHECK ("community_point_transactions"."source_type" IN ('survey_completion','redemption','reversal','expiration','admin_adjustment')),
	CONSTRAINT "community_point_transactions_sign_check" CHECK (("community_point_transactions"."type" = 'earn' AND "community_point_transactions"."points" > 0)
        OR ("community_point_transactions"."type" IN ('redeem','reverse','expire') AND "community_point_transactions"."points" < 0)
        OR ("community_point_transactions"."type" = 'admin_adjustment' AND "community_point_transactions"."points" <> 0)),
	CONSTRAINT "community_point_transactions_reversal_check" CHECK (("community_point_transactions"."type" = 'reverse' AND "community_point_transactions"."reversal_of" IS NOT NULL)
        OR ("community_point_transactions"."type" <> 'reverse' AND "community_point_transactions"."reversal_of" IS NULL)),
	CONSTRAINT "community_point_transactions_branch_business_check" CHECK ("community_point_transactions"."branch_id" IS NULL OR "community_point_transactions"."business_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_accounts" ADD CONSTRAINT "community_point_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_award_decisions" ADD CONSTRAINT "community_point_award_decisions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_award_decisions" ADD CONSTRAINT "community_point_award_decisions_account_id_community_point_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."community_point_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_award_decisions" ADD CONSTRAINT "community_point_award_decisions_rule_id_community_point_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."community_point_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_award_decisions" ADD CONSTRAINT "community_point_award_decisions_awarded_transaction_id_community_point_transactions_id_fk" FOREIGN KEY ("awarded_transaction_id") REFERENCES "public"."community_point_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_account_id_community_point_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."community_point_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_rule_id_community_point_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."community_point_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_award_decision_id_community_point_award_decisions_id_fk" FOREIGN KEY ("award_decision_id") REFERENCES "public"."community_point_award_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "community_point_transactions" ADD CONSTRAINT "community_point_transactions_reversal_of_community_point_transactions_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "public"."community_point_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_memberships_customer_key" ON "community_memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "community_memberships_status_idx" ON "community_memberships" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "community_point_accounts_customer_key" ON "community_point_accounts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "community_point_accounts_status_idx" ON "community_point_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "community_point_rules_global_version_key" ON "community_point_rules" USING btree ("source_type","version") WHERE "community_point_rules"."resource_type" IS NULL AND "community_point_rules"."resource_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "community_point_rules_resource_version_key" ON "community_point_rules" USING btree ("source_type","resource_type","resource_id","version") WHERE "community_point_rules"."resource_type" IS NOT NULL AND "community_point_rules"."resource_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "community_point_rules_source_status_idx" ON "community_point_rules" USING btree ("source_type","status");--> statement-breakpoint
CREATE INDEX "community_point_rules_resource_idx" ON "community_point_rules" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "community_point_award_decisions_source_rule_key" ON "community_point_award_decisions" USING btree ("source_type","source_ref","rule_id");--> statement-breakpoint
CREATE INDEX "community_point_award_decisions_customer_status_idx" ON "community_point_award_decisions" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "community_point_award_decisions_account_status_idx" ON "community_point_award_decisions" USING btree ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "community_point_transactions_idempotency_key" ON "community_point_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "community_point_transactions_reversal_key" ON "community_point_transactions" USING btree ("reversal_of") WHERE "community_point_transactions"."reversal_of" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "community_point_transactions_account_created_idx" ON "community_point_transactions" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "community_point_transactions_customer_created_idx" ON "community_point_transactions" USING btree ("customer_id","created_at");--> statement-breakpoint
CREATE INDEX "community_point_transactions_source_idx" ON "community_point_transactions" USING btree ("source_type","source_ref");