CREATE TABLE "branch_loyalty_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"membership_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"type" text NOT NULL,
	"units" integer NOT NULL,
	"receipt_reference" text,
	"evidence" text,
	"reversal_of" uuid,
	"related_purchase_id" uuid,
	"request_id" uuid,
	"code" uuid,
	"reward_name" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	CONSTRAINT "branch_ledger_type_check" CHECK ("branch_loyalty_ledger"."type" IN ('purchase', 'feedback_bonus', 'redemption', 'refund')),
	CONSTRAINT "branch_ledger_sign_check" CHECK (("branch_loyalty_ledger"."type" IN ('purchase', 'feedback_bonus') AND "branch_loyalty_ledger"."units" > 0) OR ("branch_loyalty_ledger"."type" IN ('redemption', 'refund') AND "branch_loyalty_ledger"."units" < 0)),
	CONSTRAINT "branch_ledger_reference_check" CHECK (("branch_loyalty_ledger"."type" = 'purchase' AND "branch_loyalty_ledger"."receipt_reference" IS NOT NULL AND "branch_loyalty_ledger"."evidence" IS NOT NULL) OR ("branch_loyalty_ledger"."type" = 'feedback_bonus' AND "branch_loyalty_ledger"."related_purchase_id" IS NOT NULL) OR ("branch_loyalty_ledger"."type" = 'redemption' AND "branch_loyalty_ledger"."code" IS NOT NULL AND "branch_loyalty_ledger"."request_id" IS NOT NULL AND "branch_loyalty_ledger"."reward_name" IS NOT NULL) OR ("branch_loyalty_ledger"."type" = 'refund' AND "branch_loyalty_ledger"."reversal_of" IS NOT NULL AND "branch_loyalty_ledger"."evidence" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "branch_loyalty_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "branch_loyalty_programs" (
	"branch_id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"onboarding_mode" text NOT NULL,
	"listed_in_community" boolean DEFAULT false NOT NULL,
	"qualifying_purchase_description" text NOT NULL,
	"unit_label" text NOT NULL,
	"reward_name" text NOT NULL,
	"reward_cost" integer NOT NULL,
	"feedback_bonus_units" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "branch_program_mode_check" CHECK ("branch_loyalty_programs"."onboarding_mode" IN ('business_only', 'community')),
	CONSTRAINT "branch_program_cost_check" CHECK ("branch_loyalty_programs"."reward_cost" > 0),
	CONSTRAINT "branch_program_feedback_bonus_check" CHECK ("branch_loyalty_programs"."feedback_bonus_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "customer_community_choices" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"joined" boolean NOT NULL,
	"policy_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "verified_purchase_id" uuid;--> statement-breakpoint
ALTER TABLE "branch_loyalty_ledger" ADD CONSTRAINT "branch_loyalty_ledger_membership_id_branch_loyalty_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "public"."branch_loyalty_memberships"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_ledger" ADD CONSTRAINT "branch_loyalty_ledger_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_ledger" ADD CONSTRAINT "branch_loyalty_ledger_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_ledger" ADD CONSTRAINT "branch_loyalty_ledger_reversal_of_branch_loyalty_ledger_id_fk" FOREIGN KEY ("reversal_of") REFERENCES "public"."branch_loyalty_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_ledger" ADD CONSTRAINT "branch_loyalty_ledger_related_purchase_id_branch_loyalty_ledger_id_fk" FOREIGN KEY ("related_purchase_id") REFERENCES "public"."branch_loyalty_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_memberships" ADD CONSTRAINT "branch_loyalty_memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_memberships" ADD CONSTRAINT "branch_loyalty_memberships_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_memberships" ADD CONSTRAINT "branch_loyalty_memberships_branch_id_branch_loyalty_programs_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branch_loyalty_programs"("branch_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_programs" ADD CONSTRAINT "branch_loyalty_programs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_loyalty_programs" ADD CONSTRAINT "branch_loyalty_programs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_community_choices" ADD CONSTRAINT "customer_community_choices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_ledger_feedback_purchase_key" ON "branch_loyalty_ledger" USING btree ("related_purchase_id") WHERE "branch_loyalty_ledger"."type" = 'feedback_bonus';--> statement-breakpoint
CREATE UNIQUE INDEX "branch_ledger_receipt_key" ON "branch_loyalty_ledger" USING btree ("business_id","branch_id","receipt_reference");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_ledger_reversal_key" ON "branch_loyalty_ledger" USING btree ("reversal_of");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_ledger_request_key" ON "branch_loyalty_ledger" USING btree ("membership_id","request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_ledger_code_key" ON "branch_loyalty_ledger" USING btree ("code");--> statement-breakpoint
CREATE INDEX "branch_ledger_membership_idx" ON "branch_loyalty_ledger" USING btree ("membership_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "branch_membership_customer_branch_key" ON "branch_loyalty_memberships" USING btree ("customer_id","branch_id");--> statement-breakpoint
CREATE INDEX "branch_membership_business_idx" ON "branch_loyalty_memberships" USING btree ("business_id");--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_verified_purchase_id_branch_loyalty_ledger_id_fk" FOREIGN KEY ("verified_purchase_id") REFERENCES "public"."branch_loyalty_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_verified_purchase_key" ON "feedback" USING btree ("verified_purchase_id");