-- Split 07/08: durable provider event evidence only; not a verified tier-effective timeline.
-- Append-only observations received exclusively after verified Stripe signature checks.
-- No issuer, activation, or modification of Split 07/08 economic guards.
CREATE TABLE stripe_subscription_tier_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 stripe_event_id text NOT NULL CONSTRAINT stripe_subscription_tier_observations_stripe_event_id_unique UNIQUE,
 stripe_event_created_at timestamptz NOT NULL,
 stripe_event_type text NOT NULL CONSTRAINT stripe_tier_observation_event_type_check CHECK (stripe_event_type IN ('customer.subscription.created','customer.subscription.updated','customer.subscription.deleted')),
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 stripe_customer_id text NOT NULL,
 stripe_subscription_id text NOT NULL,
 stripe_price_id text NOT NULL,
 status text NOT NULL,
 billing_interval text NOT NULL CONSTRAINT stripe_tier_observation_interval_check CHECK (billing_interval IN ('month','year','unknown')),
 item_period_start timestamptz,
 item_period_end timestamptz,
 provider_payload jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT stripe_tier_observation_period_order CHECK (item_period_start IS NULL OR item_period_end IS NULL OR item_period_end > item_period_start)
);
--> statement-breakpoint
CREATE INDEX stripe_tier_observation_business_event_idx ON stripe_subscription_tier_observations(business_id,stripe_event_created_at);
--> statement-breakpoint
CREATE INDEX stripe_tier_observation_subscription_event_idx ON stripe_subscription_tier_observations(stripe_subscription_id,stripe_event_created_at);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION stripe_tier_observation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Stripe tier observations are append-only'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER stripe_tier_observation_no_update_delete
 BEFORE UPDATE OR DELETE ON stripe_subscription_tier_observations
 FOR EACH ROW EXECUTE FUNCTION stripe_tier_observation_immutable();
