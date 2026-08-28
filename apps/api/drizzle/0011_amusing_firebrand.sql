ALTER TABLE "loyalty_rewards" DROP CONSTRAINT "loyalty_rewards_status_check";--> statement-breakpoint
ALTER TABLE "loyalty_rewards" DROP CONSTRAINT "loyalty_rewards_points_cost_check";--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ALTER COLUMN "points_cost" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "type" text DEFAULT 'points' NOT NULL;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "reward_value" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "start_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "expiry_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "max_rewards_per_day" integer;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "max_budget" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "limit_per" text;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "limit_period_days" integer;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD COLUMN "cooldown_seconds" integer;--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD COLUMN "issuance_status" text;--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "loyalty_rewards_business_branch_idx" ON "loyalty_rewards" USING btree ("business_id","branch_id");--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_type_check" CHECK ("loyalty_rewards"."type" IN ('points', 'discount', 'free_item', 'voucher'));--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_reward_value_check" CHECK ("loyalty_rewards"."reward_value" IS NULL OR "loyalty_rewards"."reward_value" > 0);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_max_rewards_per_day_check" CHECK ("loyalty_rewards"."max_rewards_per_day" IS NULL OR "loyalty_rewards"."max_rewards_per_day" > 0);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_max_budget_check" CHECK ("loyalty_rewards"."max_budget" IS NULL OR "loyalty_rewards"."max_budget" > 0);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_limit_per_check" CHECK ("loyalty_rewards"."limit_per" IS NULL OR "loyalty_rewards"."limit_per" IN ('receipt', 'visit', 'period'));--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_limit_period_days_check" CHECK ("loyalty_rewards"."limit_period_days" IS NULL OR "loyalty_rewards"."limit_period_days" > 0);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_cooldown_seconds_check" CHECK ("loyalty_rewards"."cooldown_seconds" IS NULL OR "loyalty_rewards"."cooldown_seconds" >= 0);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_expiry_after_start_check" CHECK ("loyalty_rewards"."expiry_date" IS NULL OR "loyalty_rewards"."start_date" IS NULL OR "loyalty_rewards"."expiry_date" > "loyalty_rewards"."start_date");--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_status_check" CHECK ("loyalty_rewards"."status" IN ('active', 'inactive', 'paused'));--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ADD CONSTRAINT "loyalty_rewards_points_cost_check" CHECK ("loyalty_rewards"."points_cost" IS NULL OR "loyalty_rewards"."points_cost" > 0);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ADD CONSTRAINT "loyalty_transactions_issuance_status_check" CHECK ("loyalty_transactions"."issuance_status" IS NULL OR "loyalty_transactions"."issuance_status" IN ('pending', 'issued', 'redeemed', 'expired', 'reversed'));