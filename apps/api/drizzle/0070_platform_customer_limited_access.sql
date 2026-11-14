ALTER TABLE "customer_sanctions" DROP CONSTRAINT "customer_sanctions_action_check";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "limited_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_sanctions" ADD CONSTRAINT "customer_sanctions_action_check" CHECK ("customer_sanctions"."action" IN ('warning', 'limit', 'suspend', 'ban', 'lift'));