ALTER TABLE "loyalty_rewards" ALTER COLUMN "reward_value" SET DATA TYPE numeric(11, 3);--> statement-breakpoint
ALTER TABLE "loyalty_rewards" ALTER COLUMN "max_budget" SET DATA TYPE numeric(11, 3);--> statement-breakpoint
ALTER TABLE "loyalty_purchase_events" ALTER COLUMN "qualifying_amount" SET DATA TYPE numeric(11, 3);--> statement-breakpoint
ALTER TABLE "loyalty_transactions" ALTER COLUMN "purchase_amount" SET DATA TYPE numeric(11, 3);