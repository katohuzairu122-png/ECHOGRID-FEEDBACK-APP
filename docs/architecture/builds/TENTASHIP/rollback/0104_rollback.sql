-- ROLLBACK EVIDENCE for migration 0104 (governance_operator_lifecycle_decision_policies). NOT EXECUTED against any shared database. Run only on Owner instruction, in a transaction,
-- after a restore point exists. It restores the 0101 guard functions (no expiry, scope, revocation or policy checks), removes the G5 tables/columns and the lifecycle constraints.
-- It FAILS (safely) if two assignments exist for the same user and role (a revoked plus a current one), which must then be reviewed rather than altered.
-- Afterwards delete the newest drizzle ledger row (0104) so a later upgrade re-applies it.
BEGIN;
DROP TRIGGER IF EXISTS governance_operators_guard_trg ON governance_operators;
ALTER TABLE governance_cases DROP COLUMN IF EXISTS decision_policy_id;
DROP TABLE IF EXISTS governance_operator_events;
DROP TABLE IF EXISTS governance_decision_policies;
DROP FUNCTION IF EXISTS governance_policy_guard();
DROP FUNCTION IF EXISTS governance_operator_events_guard();
CREATE OR REPLACE FUNCTION governance_cases_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE subject_ok boolean := false; creator uuid; need_role text; rel governance_cases%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' OR NEW.reviewer_user_id IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.escalation_reason IS NOT NULL THEN
      RAISE EXCEPTION 'GOVERNANCE_CASE_NOT_ALLOWED (a case starts open and undecided)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    subject_ok := CASE NEW.subject_type
      WHEN 'shuffle_campaign_version' THEN NEW.subject_id = NEW.campaign_version_id
      WHEN 'shuffle_entry' THEN EXISTS (SELECT 1 FROM shuffle_entries WHERE id = NEW.subject_id AND campaign_version_id = NEW.campaign_version_id)
      WHEN 'shuffle_selection' THEN EXISTS (SELECT 1 FROM shuffle_selection_results WHERE id = NEW.subject_id AND campaign_version_id = NEW.campaign_version_id)
      WHEN 'drop_sponsorship' THEN NEW.subject_id = NEW.sponsorship_id
      WHEN 'drop_reservation' THEN EXISTS (SELECT 1 FROM drop_reservations WHERE id = NEW.subject_id AND sponsorship_id = NEW.sponsorship_id)
      ELSE false END;
    IF NOT subject_ok THEN RAISE EXCEPTION 'GOVERNANCE_CASE_SUBJECT_INVALID (the subject does not exist under the referenced campaign or sponsorship)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.related_case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM governance_cases WHERE id = NEW.related_case_id) THEN
      RAISE EXCEPTION 'GOVERNANCE_CASE_SUBJECT_INVALID (related case)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind OR NEW.subject_type <> OLD.subject_type OR NEW.subject_id <> OLD.subject_id OR NEW.campaign_version_id IS DISTINCT FROM OLD.campaign_version_id
     OR NEW.sponsorship_id IS DISTINCT FROM OLD.sponsorship_id OR NEW.classification <> OLD.classification OR NEW.summary <> OLD.summary OR NEW.opened_by_user_id <> OLD.opened_by_user_id
     OR NEW.related_case_id IS DISTINCT FROM OLD.related_case_id OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  need_role := CASE WHEN NEW.kind = 'fraud' THEN 'fraud_investigator' ELSE 'dispute_resolver' END;
  IF OLD.status = 'open' AND NEW.status = 'escalated' THEN
    IF NEW.escalation_reason IS NULL OR char_length(NEW.escalation_reason) < 10 THEN RAISE EXCEPTION 'GOVERNANCE_REASON_REQUIRED (escalation)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF NEW.reviewer_user_id IS NOT NULL OR NEW.decision IS NOT NULL THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status IN ('open','escalated') AND NEW.status = 'under_review' THEN
    IF NEW.reviewer_user_id IS NULL OR NEW.reviewer_user_id = OLD.opened_by_user_id OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.reviewer_user_id AND go_.role = need_role AND go_.active) THEN
      RAISE EXCEPTION 'GOVERNANCE_REVIEWER_NOT_ALLOWED (an assigned %, who did not open the case, is required)', need_role USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.decision IS NOT NULL OR NEW.escalation_reason IS DISTINCT FROM OLD.escalation_reason THEN RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (review fields)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'under_review' AND NEW.status = 'decided' THEN
    IF NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_by_user_id IS DISTINCT FROM OLD.reviewer_user_id OR NEW.decided_by_user_id = OLD.opened_by_user_id
       OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.decided_by_user_id AND go_.role = need_role AND go_.active) THEN
      RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (the assigned reviewer must decide, must not have opened the case and must hold the operator role)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.subject_type LIKE 'shuffle_%' THEN
      SELECT c.created_by_user_id INTO creator FROM shuffle_campaign_versions v JOIN shuffle_campaigns c ON c.id = v.campaign_id WHERE v.id = OLD.campaign_version_id;
    ELSE
      SELECT created_by_user_id INTO creator FROM drop_sponsorships WHERE id = OLD.sponsorship_id;
    END IF;
    IF NEW.decided_by_user_id = creator THEN RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (an administrator who created the campaign or sponsorship cannot decide a case about it)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    IF OLD.related_case_id IS NOT NULL THEN
      SELECT * INTO rel FROM governance_cases WHERE id = OLD.related_case_id;
      IF NEW.decided_by_user_id IN (rel.reviewer_user_id, rel.decided_by_user_id) THEN RAISE EXCEPTION 'GOVERNANCE_DECIDER_NOT_ALLOWED (the fraud investigator and the dispute approver must be different people)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'decided' AND NEW.status = 'closed' THEN
    IF NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_by_user_id IS DISTINCT FROM OLD.decided_by_user_id OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason OR NEW.reviewer_user_id IS DISTINCT FROM OLD.reviewer_user_id THEN
      RAISE EXCEPTION 'GOVERNANCE_CASE_IMMUTABLE (a recorded decision is never rewritten)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'GOVERNANCE_CASE_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE OR REPLACE FUNCTION governance_overrides_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE c_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (DELETE)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO c_status FROM governance_cases WHERE id = NEW.case_id;
    IF NEW.status <> 'requested' OR NEW.approved_by_user_id IS NOT NULL OR NEW.expires_at <= now() OR c_status IS NULL OR c_status NOT IN ('under_review','decided')
       OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.requested_by_user_id AND go_.role = 'fraud_investigator' AND go_.active) THEN
      RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_NOT_ALLOWED (needs a case under review or decided, an assigned fraud investigator as requester and a future expiry)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.case_id <> OLD.case_id OR NEW.scope <> OLD.scope OR NEW.target_id <> OLD.target_id OR NEW.justification <> OLD.justification OR NEW.evidence_hash <> OLD.evidence_hash
     OR NEW.requested_by_user_id <> OLD.requested_by_user_id OR NEW.expires_at <> OLD.expires_at OR NEW.synthetic <> OLD.synthetic OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (identity)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD.status = 'requested' AND NEW.status = 'approved' THEN
    IF NEW.approved_by_user_id IS NULL OR NEW.approved_by_user_id = OLD.requested_by_user_id OR NOT EXISTS (SELECT 1 FROM governance_operators go_ WHERE go_.user_id = NEW.approved_by_user_id AND go_.role = 'dispute_resolver' AND go_.active) OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'GOVERNANCE_APPROVAL_NOT_ALLOWED (a different assigned dispute resolver, before expiry, is required)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF OLD.status = 'approved' AND NEW.status = 'executed' THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id OR OLD.expires_at <= now() THEN RAISE EXCEPTION 'GOVERNANCE_APPROVAL_NOT_ALLOWED (expired or altered approval)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF (OLD.status = 'requested' AND NEW.status IN ('rejected','cancelled')) OR (OLD.status = 'approved' AND NEW.status = 'cancelled') THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (approver)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSIF OLD.status IN ('requested','approved') AND NEW.status = 'expired' AND OLD.expires_at <= now() THEN
    IF NEW.approved_by_user_id IS DISTINCT FROM OLD.approved_by_user_id THEN RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_IMMUTABLE (approver)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  ELSE
    RAISE EXCEPTION 'GOVERNANCE_OVERRIDE_TRANSITION_NOT_ALLOWED (% -> %)', OLD.status, NEW.status USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  NEW.status_changed_at := now();
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION governance_operators_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GOVERNANCE_LEDGER_APPEND_ONLY (DELETE on governance_operators)' USING ERRCODE = 'integrity_constraint_violation'; END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.user_id <> OLD.user_id OR NEW.role <> OLD.role OR NEW.created_at <> OLD.created_at) THEN
    RAISE EXCEPTION 'GOVERNANCE_OPERATOR_IMMUTABLE (only the active flag can change)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
DROP INDEX IF EXISTS governance_operators_current_uq;
ALTER TABLE governance_operators DROP CONSTRAINT IF EXISTS governance_operators_scope, DROP CONSTRAINT IF EXISTS governance_operators_window, DROP CONSTRAINT IF EXISTS governance_operators_revocation_shape;
ALTER TABLE governance_operators DROP COLUMN IF EXISTS scope, DROP COLUMN IF EXISTS valid_from, DROP COLUMN IF EXISTS expires_at, DROP COLUMN IF EXISTS assigned_by_user_id, DROP COLUMN IF EXISTS revoked_at, DROP COLUMN IF EXISTS revoked_by_user_id, DROP COLUMN IF EXISTS revocation_reason;
CREATE UNIQUE INDEX governance_operators_user_role_uq ON governance_operators USING btree (user_id, role);
CREATE TRIGGER governance_operators_guard_trg BEFORE UPDATE OR DELETE ON governance_operators FOR EACH ROW EXECUTE FUNCTION governance_operators_guard();
ALTER TABLE governance_operators ENABLE ALWAYS TRIGGER governance_operators_guard_trg;
-- DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations);  -- run after verifying the above
COMMIT;
