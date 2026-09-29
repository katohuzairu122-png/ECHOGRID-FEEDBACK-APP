-- Replace the launch placeholder catalog with the approved affordable plans.
-- Existing Stripe IDs for changed prices are cleared so checkout cannot charge
-- an old amount; create matching Prices in Stripe and reconnect them in Platform Billing.
INSERT INTO "subscription_plans" (
  "key", "name", "description", "price_monthly_cents", "price_yearly_cents",
  "currency", "stripe_price_id_monthly", "stripe_price_id_yearly",
  "max_branches", "max_users", "features", "is_active",
  "is_default_trial", "sort_order"
)
VALUES
  ('free', 'Free', 'Explore Echo Grid with a small monthly feedback allowance.',
   0, NULL, 'usd', NULL, NULL, 1, 1,
   '{"monthlyResponses":25,"aiSummaries":false,"customBranding":false}'::jsonb,
   true, false, 0),
  ('starter', 'Starter', 'For one location ready to collect feedback every day.',
   900, 9000, 'usd', NULL, NULL, 1, 3,
   '{"monthlyResponses":1000,"aiSummaries":false,"customBranding":false}'::jsonb,
   true, true, 1),
  ('growth', 'Growth', 'For growing teams managing feedback across several locations.',
   2900, 29000, 'usd', NULL, NULL, 5, 10,
   '{"monthlyResponses":5000,"aiSummaries":true,"customBranding":false}'::jsonb,
   true, false, 2),
  ('business', 'Business',
   'For established multi-location teams that need higher limits and AI insights.',
   5900, 59000, 'usd', NULL, NULL, 15, 30,
   '{"monthlyResponses":20000,"aiSummaries":true,"customBranding":true}'::jsonb,
   true, false, 3),
  ('enterprise', 'Enterprise',
   'Custom limits, onboarding, and support for large organizations.',
   0, NULL, 'usd', NULL, NULL, NULL, NULL,
   '{"monthlyResponses":null,"aiSummaries":true,"customBranding":true}'::jsonb,
   true, false, 4)
ON CONFLICT ("key") DO UPDATE SET
  "name" = EXCLUDED."name",
  "description" = EXCLUDED."description",
  "price_monthly_cents" = EXCLUDED."price_monthly_cents",
  "price_yearly_cents" = EXCLUDED."price_yearly_cents",
  "currency" = EXCLUDED."currency",
  "stripe_price_id_monthly" = NULL,
  "stripe_price_id_yearly" = NULL,
  "max_branches" = EXCLUDED."max_branches",
  "max_users" = EXCLUDED."max_users",
  "features" = EXCLUDED."features",
  "is_active" = EXCLUDED."is_active",
  "is_default_trial" = EXCLUDED."is_default_trial",
  "sort_order" = EXCLUDED."sort_order",
  "updated_at" = now();
