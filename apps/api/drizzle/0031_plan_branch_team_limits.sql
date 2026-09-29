-- Enforce plan branch and distinct team-member limits at the database
-- boundary. Advisory locks make count + insert safe across Worker isolates.
CREATE OR REPLACE FUNCTION echo_grid_enforce_branch_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  branch_limit integer;
  branch_count integer;
BEGIN
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
CREATE TRIGGER branches_enforce_plan_limit
BEFORE INSERT ON "branches"
FOR EACH ROW EXECUTE FUNCTION echo_grid_enforce_branch_limit();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION echo_grid_enforce_team_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  user_limit integer;
  user_count integer;
BEGIN
  -- Extra roles or branch grants for an existing member do not consume seats.
  IF EXISTS (
    SELECT 1
      FROM user_business_roles
     WHERE business_id = NEW.business_id
       AND user_id = NEW.user_id
       AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.business_id::text || ':users', 0));

  -- Recheck after acquiring the lock: another transaction may have granted
  -- this same user a role while this insert was waiting.
  IF EXISTS (
    SELECT 1
      FROM user_business_roles
     WHERE business_id = NEW.business_id
       AND user_id = NEW.user_id
       AND deleted_at IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  SELECT sp.max_users
    INTO user_limit
    FROM business_subscriptions bs
    JOIN subscription_plans sp ON sp.id = bs.plan_id
   WHERE bs.business_id = NEW.business_id;

  IF NOT FOUND THEN
    SELECT max_users INTO user_limit FROM subscription_plans WHERE key = 'free';
  END IF;

  IF user_limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT count(DISTINCT user_id)::integer
    INTO user_count
    FROM user_business_roles
   WHERE business_id = NEW.business_id
     AND deleted_at IS NULL;

  IF user_count >= user_limit THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'PLAN_TEAM_LIMIT_REACHED';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_business_roles_enforce_plan_limit
BEFORE INSERT ON "user_business_roles"
FOR EACH ROW EXECUTE FUNCTION echo_grid_enforce_team_limit();
