-- Split 08 CE-1 tenant integrity (forward-only, additive). The reservation/application tables are inert (0042 guards deny all
-- writes) and hold no rows, so the foreign keys validate trivially. The UNIQUE constraints are composite FK targets on populated
-- tables: (id, ...) is already unique via the primary key, so they cannot fail. They are created FIRST because the foreign keys
-- depend on them. No guard, trigger or existing constraint is altered.
ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_id_business_key" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "partner_credit_accounts" ADD CONSTRAINT "partner_credit_accounts_id_business_key" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "partner_credit_award_decisions" ADD CONSTRAINT "partner_credit_awards_id_business_key" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "partner_credit_lots" ADD CONSTRAINT "partner_credit_lots_id_decision_account_key" UNIQUE("id","decision_id","account_id");--> statement-breakpoint
ALTER TABLE "partner_credit_reservations" ADD CONSTRAINT "partner_credit_reservations_id_business_key" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "billing_partner_credit_applications" ADD CONSTRAINT "billing_partner_credit_applications_reservation_business_fk" FOREIGN KEY ("reservation_id","business_id") REFERENCES "public"."partner_credit_reservations"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_partner_credit_applications" ADD CONSTRAINT "billing_partner_credit_applications_subscription_business_fk" FOREIGN KEY ("subscription_id","business_id") REFERENCES "public"."business_subscriptions"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_reservations" ADD CONSTRAINT "partner_credit_reservations_decision_business_fk" FOREIGN KEY ("decision_id","business_id") REFERENCES "public"."partner_credit_award_decisions"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_reservations" ADD CONSTRAINT "partner_credit_reservations_account_business_fk" FOREIGN KEY ("account_id","business_id") REFERENCES "public"."partner_credit_accounts"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "partner_credit_reservations" ADD CONSTRAINT "partner_credit_reservations_lot_decision_account_fk" FOREIGN KEY ("lot_id","decision_id","account_id") REFERENCES "public"."partner_credit_lots"("id","decision_id","account_id") ON DELETE restrict ON UPDATE no action;
