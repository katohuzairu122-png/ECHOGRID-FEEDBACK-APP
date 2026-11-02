-- Inert integrity storage only. No append capability or financial authority.
-- Refuse all existing candidate/partial objects; never silently adopt or replace.
SET LOCAL search_path = public, pg_catalog;
--> statement-breakpoint
DO $$ BEGIN
 IF to_regclass('public.s08_allocation_freezes') IS NOT NULL
 OR to_regclass('public.s08_allocation_freeze_items') IS NOT NULL
 OR to_regprocedure('public.s08_allocation_deny_mutation()') IS NOT NULL THEN
   RAISE EXCEPTION 'S08_ALLOCATION_PREEXISTING_OBJECTS';
 END IF;
END $$;
--> statement-breakpoint
CREATE TABLE "s08_allocation_freeze_items" (
	"freeze_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"reservation_id" uuid NOT NULL,
	"invoice_intent_ref" text NOT NULL,
	"benefit_minor" bigint NOT NULL,
	"provider_idempotency_key" text NOT NULL,
	CONSTRAINT "s08_allocation_freeze_items_freeze_id_reservation_id_pk" PRIMARY KEY("freeze_id","reservation_id"),
	CONSTRAINT "s08_allocation_freeze_items_reservation_id_key" UNIQUE("reservation_id"),
	CONSTRAINT "s08_allocation_freeze_items_provider_idempotency_key_key" UNIQUE("provider_idempotency_key"),
	CONSTRAINT "s08_allocation_freeze_items_benefit_minor_check" CHECK ("s08_allocation_freeze_items"."benefit_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "s08_allocation_freezes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"invoice_ref" text NOT NULL,
	"currency" text NOT NULL,
	"policy_version" text NOT NULL,
	"allocation_digest" text NOT NULL,
	"aggregate_benefit_minor" bigint NOT NULL,
	"reservation_count" integer NOT NULL,
	"artifact" jsonb NOT NULL,
	"provider_verified" boolean DEFAULT false NOT NULL,
	"consumption_authorized" boolean DEFAULT false NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "s08_allocation_freezes_business_id_invoice_ref_key" UNIQUE("business_id","invoice_ref"),
	CONSTRAINT "s08_allocation_freezes_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "s08_allocation_freezes_currency_check" CHECK ("s08_allocation_freezes"."currency" ~ '^[a-z]{3}$'),
	CONSTRAINT "s08_allocation_freezes_policy_version_check" CHECK ("s08_allocation_freezes"."policy_version" = 'S08-AGG-ROUND/1'),
	CONSTRAINT "s08_allocation_freezes_allocation_digest_check" CHECK ("s08_allocation_freezes"."allocation_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "s08_allocation_freezes_aggregate_benefit_minor_check" CHECK ("s08_allocation_freezes"."aggregate_benefit_minor" > 0),
	CONSTRAINT "s08_allocation_freezes_reservation_count_check" CHECK ("s08_allocation_freezes"."reservation_count" BETWEEN 1 AND 10),
	CONSTRAINT "s08_allocation_freezes_artifact_check" CHECK (jsonb_typeof("s08_allocation_freezes"."artifact") = 'object'),
	CONSTRAINT "s08_allocation_freezes_provider_verified_check" CHECK ("s08_allocation_freezes"."provider_verified" = false),
	CONSTRAINT "s08_allocation_freezes_consumption_authorized_check" CHECK ("s08_allocation_freezes"."consumption_authorized" = false)
);
--> statement-breakpoint
ALTER TABLE "s08_allocation_freeze_items" ADD CONSTRAINT "s08_allocation_freeze_items_freeze_id_business_id_s08_allocation_freezes_id_business_id_fk" FOREIGN KEY ("freeze_id","business_id") REFERENCES "public"."s08_allocation_freezes"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s08_allocation_freeze_items" ADD CONSTRAINT "s08_allocation_freeze_items_reservation_id_business_id_partner_credit_reservations_id_business_id_fk" FOREIGN KEY ("reservation_id","business_id") REFERENCES "public"."partner_credit_reservations"("id","business_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s08_allocation_freezes" ADD CONSTRAINT "s08_allocation_freezes_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION public.s08_allocation_deny_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
 RAISE EXCEPTION 'S08_ALLOCATION_INERT';
END $$;
--> statement-breakpoint
CREATE TRIGGER s08_allocation_parent_deny
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.s08_allocation_freezes
FOR EACH STATEMENT EXECUTE FUNCTION public.s08_allocation_deny_mutation();
--> statement-breakpoint
CREATE TRIGGER s08_allocation_child_deny
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.s08_allocation_freeze_items
FOR EACH STATEMENT EXECUTE FUNCTION public.s08_allocation_deny_mutation();
--> statement-breakpoint
REVOKE ALL ON TABLE public.s08_allocation_freezes, public.s08_allocation_freeze_items FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.s08_allocation_deny_mutation() FROM PUBLIC;
