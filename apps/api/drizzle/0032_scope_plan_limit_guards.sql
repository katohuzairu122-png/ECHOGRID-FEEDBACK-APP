-- Limit enforcement belongs on customer-facing writes. Internal fixtures,
-- imports and maintenance jobs create rows without an actor and must remain
-- able to reconstruct historical data above today's plan allowance.
CREATE OR REPLACE FUNCTION echo_grid_enforce_branch_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  branch_limit integer;
  branch_count integer;
BEGIN
  IF NEW.created_by IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id::text || ':branches', 0));

  SELECT sp.max_branches
    INTO branch_limit
    FROM business_subscriptions bs
    JOIN subscription_plans sp ON sp.id = bs.plan_id
   WHERE bs.business_id = NEW.business_id;

  IF NOT FOUND THEN
    SELECT max_branches INTO branch_limit FROM subscription_plans WHERE key = 'free';
  END IF;

  IF branch_limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(*)::integer
    INTO branch_count
    FROM branches
   WHERE business_id = NEW.business_id
     AND is_deleted = false;

  IF branch_count >= branch_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'PLAN_BRANCH_LIMIT_REACHED';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_business_roles_enforce_plan_limit ON "user_business_roles";
--> statement-breakpoint
DROP FUNCTION IF EXISTS echo_grid_enforce_team_limit();
