-- Enforce plan response allowances at the database boundary. The public
-- feedback endpoint keeps accepting submissions; rows beyond the monthly
-- allowance wait for seven days and are unlocked automatically by an upgrade.
ALTER TABLE "feedback"
  ADD COLUMN "entitlement_status" text NOT NULL DEFAULT 'included',
  ADD COLUMN "queued_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "feedback"
  ADD CONSTRAINT "feedback_entitlement_status_check"
  CHECK ("entitlement_status" IN ('included', 'queued'));
--> statement-breakpoint
CREATE INDEX "feedback_business_entitlement_created_idx"
  ON "feedback" ("business_id", "entitlement_status", "created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION echo_grid_apply_response_allowance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  response_limit integer;
  included_count integer;
  month_start timestamptz := date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  -- Serialize count + decision per business across Worker isolates so two
  -- simultaneous submissions cannot both consume the final included slot.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id::text, 0));

  SELECT (sp.features ->> 'monthlyResponses')::integer
    INTO response_limit
    FROM business_subscriptions bs
    JOIN subscription_plans sp ON sp.id = bs.plan_id
   WHERE bs.business_id = NEW.business_id;

  -- Businesses predating subscription provisioning receive the Free limit.
  IF NOT FOUND THEN
    SELECT (features ->> 'monthlyResponses')::integer
      INTO response_limit
      FROM subscription_plans
     WHERE key = 'free';
  END IF;

  -- JSON null represents an unlimited allowance (Enterprise).
  IF response_limit IS NULL THEN
    NEW.entitlement_status := 'included';
    NEW.queued_until := NULL;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
    INTO included_count
    FROM feedback
   WHERE business_id = NEW.business_id
     AND entitlement_status = 'included'
     AND is_deleted = false
     AND created_at >= month_start;

  IF included_count >= response_limit THEN
    NEW.entitlement_status := 'queued';
    NEW.queued_until := CURRENT_TIMESTAMP + interval '7 days';
  ELSE
    NEW.entitlement_status := 'included';
    NEW.queued_until := NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER feedback_apply_response_allowance
BEFORE INSERT ON "feedback"
FOR EACH ROW EXECUTE FUNCTION echo_grid_apply_response_allowance();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION echo_grid_unlock_queued_feedback()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  response_limit integer;
  included_count integer;
  available_slots integer;
  month_start timestamptz := date_trunc('month', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id::text, 0));

  SELECT (features ->> 'monthlyResponses')::integer
    INTO response_limit
    FROM subscription_plans
   WHERE id = NEW.plan_id;

  IF response_limit IS NULL THEN
    UPDATE feedback
       SET entitlement_status = 'included', queued_until = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = NEW.business_id
       AND entitlement_status = 'queued'
       AND queued_until > CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
    INTO included_count
    FROM feedback
   WHERE business_id = NEW.business_id
     AND entitlement_status = 'included'
     AND is_deleted = false
     AND created_at >= month_start;

  available_slots := greatest(response_limit - included_count, 0);
  IF available_slots > 0 THEN
    WITH candidates AS (
      SELECT id
        FROM feedback
       WHERE business_id = NEW.business_id
         AND entitlement_status = 'queued'
         AND queued_until > CURRENT_TIMESTAMP
       ORDER BY created_at
       LIMIT available_slots
    )
    UPDATE feedback f
       SET entitlement_status = 'included', queued_until = NULL, updated_at = CURRENT_TIMESTAMP
      FROM candidates c
     WHERE f.id = c.id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER business_subscription_unlock_queued_feedback
AFTER INSERT OR UPDATE ON "business_subscriptions"
FOR EACH ROW EXECUTE FUNCTION echo_grid_unlock_queued_feedback();
