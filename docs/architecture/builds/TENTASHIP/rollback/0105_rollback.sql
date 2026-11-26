-- ROLLBACK EVIDENCE for migration 0105 (sponsor_applications_fulfilment_policies). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction,
-- after a restore point exists. It restores the 0100 drop_sponsorships_guard and drop_reservations_guard (no sponsor-approval requirement) and drops the G6 tables.
-- Afterwards delete the newest drizzle ledger row (0105) so a later upgrade re-applies it.
BEGIN;
CREATE OR REPLACE FUNCTION drop_sponsorships_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE ok boolean := false; v_sponsorship uuid; v_qty integer; latest integer; chosen integer; has_inv boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.approved_version_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_NOT_ALLOWED (starts as a draft without review)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.key <> OLD.key OR NEW.business_id <> OLD.business_id OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = NEW.status THEN
    IF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  ok := (OLD.status = 'draft' AND NEW.status IN ('submitted','cancelled'))
     OR (OLD.status = 'submitted' AND NEW.status IN ('under_review','cancelled'))
     OR (OLD.status = 'under_review' AND NEW.status IN ('approved','draft','cancelled'))
     OR (OLD.status = 'approved' AND NEW.status IN ('scheduled','suspended','cancelled'))
     OR (OLD.status = 'scheduled' AND NEW.status IN ('available','suspended','cancelled'))
     OR (OLD.status = 'available' AND NEW.status IN ('suspended','cancelled','expired'))
     OR (OLD.status = 'suspended' AND NEW.status IN ('available','cancelled'));
  IF NOT ok THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF NEW.status IN ('draft','suspended','cancelled') AND NEW.status_reason IS NULL THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status = 'approved' THEN
    -- separation of duties: a reviewer who is not the creator, approving the LATEST version of this sponsorship
    IF NEW.reviewed_by_user_id IS NULL OR NEW.reviewed_by_user_id = OLD.created_by_user_id OR NEW.approved_version_id IS NULL THEN
      RAISE EXCEPTION 'DROP_SPONSORSHIP_REVIEW_REQUIRED (an independent reviewer and the approved version are required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT max(version) INTO latest FROM drop_sponsorship_versions WHERE sponsorship_id = OLD.id;
    SELECT version INTO chosen FROM drop_sponsorship_versions WHERE id = NEW.approved_version_id AND sponsorship_id = OLD.id;
    IF chosen IS NULL OR chosen <> latest THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_REVIEW_REQUIRED (approve the latest version of this sponsorship)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF NEW.approved_version_id IS DISTINCT FROM OLD.approved_version_id OR NEW.reviewed_by_user_id IS DISTINCT FROM OLD.reviewed_by_user_id OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at THEN
    IF NOT (NEW.status = 'draft') THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  END IF;
  IF NEW.status = 'draft' AND (NEW.approved_version_id IS NOT NULL OR NEW.reviewed_by_user_id IS NOT NULL) THEN
    RAISE EXCEPTION 'DROP_SPONSORSHIP_IMMUTABLE (a returned draft clears the review)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('scheduled','available') THEN
    SELECT EXISTS (SELECT 1 FROM drop_inventory WHERE sponsorship_id = OLD.id) INTO has_inv;
    IF NEW.approved_version_id IS NULL OR NOT has_inv THEN RAISE EXCEPTION 'DROP_SPONSORSHIP_NOT_READY (approved version and inventory are required)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION drop_reservations_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE s_status text; w_end timestamptz; n integer;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'DROP_RESERVATION_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  SELECT s.status, v.collection_window_end INTO s_status, w_end FROM drop_sponsorships s JOIN drop_sponsorship_versions v ON v.id = s.approved_version_id WHERE s.id = NEW.sponsorship_id;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'reserved' OR s_status IS DISTINCT FROM 'available' OR NEW.hold_expires_at <= now() THEN
      RAISE EXCEPTION 'DROP_RESERVATION_NOT_ALLOWED (needs an available sponsorship and a hold that expires in the future)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    UPDATE drop_inventory SET reserved = reserved + 1
      WHERE sponsorship_id = NEW.sponsorship_id AND reserved + allocated + collected + expired < total_quantity;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 1 THEN RAISE EXCEPTION 'DROP_INVENTORY_EXHAUSTED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.sponsorship_id <> OLD.sponsorship_id OR NEW.customer_id <> OLD.customer_id OR NEW.hold_expires_at <> OLD.hold_expires_at OR NEW.eligibility_evidence <> OLD.eligibility_evidence
     OR NEW.synthetic <> OLD.synthetic OR NEW.created_by_user_id <> OLD.created_by_user_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'DROP_RESERVATION_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'reserved' AND NEW.status = 'allocated' THEN
    IF s_status IS DISTINCT FROM 'available' OR OLD.hold_expires_at <= now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_ALLOWED (sponsorship not available or the hold expired)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET reserved = reserved - 1, allocated = allocated + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'released' THEN
    UPDATE drop_inventory SET reserved = reserved - 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'reserved' AND NEW.status = 'expired' THEN
    IF OLD.hold_expires_at > now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_EXPIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET reserved = reserved - 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'allocated' AND NEW.status = 'collected' THEN
    UPDATE drop_inventory SET allocated = allocated - 1, collected = collected + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = 'allocated' AND NEW.status = 'expired' THEN
    IF w_end > now() THEN RAISE EXCEPTION 'DROP_RESERVATION_NOT_EXPIRED (collection window still open)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    UPDATE drop_inventory SET allocated = allocated - 1, expired = expired + 1 WHERE sponsorship_id = NEW.sponsorship_id;
  ELSIF OLD.status = NEW.status THEN
    RETURN NEW;
  ELSE
    RAISE EXCEPTION 'DROP_RESERVATION_TRANSITION_NOT_ALLOWED (% -> %); an allocated unit is never silently withdrawn', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW.status IN ('released') AND NEW.status_reason IS NULL THEN RAISE EXCEPTION 'DROP_RESERVATION_REASON_REQUIRED' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
DROP TABLE IF EXISTS sponsor_application_events;
DROP TABLE IF EXISTS sponsor_applications;
DROP TABLE IF EXISTS drop_fulfilment_policies;
DROP FUNCTION IF EXISTS sponsor_applications_guard();
DROP FUNCTION IF EXISTS sponsor_application_events_guard();
DROP FUNCTION IF EXISTS drop_fulfilment_policy_guard();
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
