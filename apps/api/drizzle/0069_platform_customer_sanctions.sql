CREATE TABLE "customer_sanctions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"suspended_until" timestamp with time zone,
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_sanctions_action_check" CHECK ("customer_sanctions"."action" IN ('warning', 'suspend', 'ban', 'lift')),
	CONSTRAINT "customer_sanctions_reason_check" CHECK (length(btrim("customer_sanctions"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_status_check";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "suspended_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_sanctions" ADD CONSTRAINT "customer_sanctions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sanctions" ADD CONSTRAINT "customer_sanctions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_sanctions_customer_idx" ON "customer_sanctions" USING btree ("customer_id","created_at");--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_status_check" CHECK ("customers"."status" IN ('active', 'suspended', 'banned'));