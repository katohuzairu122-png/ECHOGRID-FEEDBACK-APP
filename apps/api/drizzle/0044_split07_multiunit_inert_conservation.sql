-- Split 07 multi-unit accounting FOUNDATION ONLY. No award or redemption activation.
-- SQL-owned additive evidence tables; legacy PC-ECON/1 remains unchanged.
CREATE TABLE partner_credit_multiunit_lot_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  decision_id uuid NOT NULL REFERENCES partner_credit_award_decisions(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES partner_credit_lots(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES partner_credit_accounts(id) ON DELETE RESTRICT,
  allocation_key text NOT NULL UNIQUE,
  units_issued integer NOT NULL CHECK (units_issued > 0 AND units_issued <= 10),
  units_provisional integer NOT NULL DEFAULT 0 CHECK (units_provisional >= 0),
  units_available integer NOT NULL DEFAULT 0 CHECK (units_available >= 0),
  units_reserved integer NOT NULL DEFAULT 0 CHECK (units_reserved >= 0),
  units_consumed integer NOT NULL DEFAULT 0 CHECK (units_consumed >= 0),
  units_expired integer NOT NULL DEFAULT 0 CHECK (units_expired >= 0),
  units_reversed integer NOT NULL DEFAULT 0 CHECK (units_reversed >= 0),
  units_recovery_offset integer NOT NULL DEFAULT 0 CHECK (units_recovery_offset >= 0),
  earning_month_utc text NOT NULL CHECK (earning_month_utc ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pc_multiunit_lot_once UNIQUE (lot_id),
  CONSTRAINT pc_multiunit_decision_once UNIQUE (decision_id),
  CONSTRAINT pc_multiunit_exact_conservation CHECK (
    units_provisional + units_available + units_reserved + units_consumed +
    units_expired + units_reversed + units_recovery_offset = units_issued
  )
);
--> statement-breakpoint
CREATE INDEX pc_multiunit_business_month_idx
 ON partner_credit_multiunit_lot_allocations(business_id, earning_month_utc);
--> statement-breakpoint
CREATE TABLE partner_credit_multiunit_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES partner_credit_multiunit_lot_allocations(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  source_bucket text NOT NULL,
  destination_bucket text NOT NULL,
  units integer NOT NULL CHECK (units > 0),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pc_multiunit_distinct_buckets CHECK (source_bucket <> destination_bucket),
  CONSTRAINT pc_multiunit_source_bucket CHECK (source_bucket IN
    ('provisional','available','reserved','consumed','expired','reversed','recovery_offset')),
  CONSTRAINT pc_multiunit_destination_bucket CHECK (destination_bucket IN
    ('provisional','available','reserved','consumed','expired','reversed','recovery_offset'))
);
--> statement-breakpoint
-- A stable business/month lock can coordinate all branches once an
-- independently reviewed economic transition function is authorized.
-- No current caller can use this routine to grant or spend units.
CREATE OR REPLACE FUNCTION pc_multiunit_month_lock(
  p_business_id uuid, p_month text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 IF p_business_id IS NULL OR p_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
   RAISE EXCEPTION 'Invalid Partner Credit business/month lock key';
 END IF;
 PERFORM pg_advisory_xact_lock(
   hashtextextended('partner_credit_multiunit:' || p_business_id::text || ':' || p_month, 0)
 );
END;
$$;
--> statement-breakpoint
-- Both new tables are explicitly inert. They are NOT an economic bypass:
-- even privileged application code cannot insert, modify or delete rows
-- while these triggers are enabled. Migrations 0041/0042 remain intact.
CREATE OR REPLACE FUNCTION pc_multiunit_evidence_inert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Split 07 multi-unit economic writes disabled pending separate activation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER pc_multiunit_allocation_inert_guard
 BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_multiunit_lot_allocations
 FOR EACH ROW EXECUTE FUNCTION pc_multiunit_evidence_inert_guard();
--> statement-breakpoint
CREATE TRIGGER pc_multiunit_movement_inert_guard
 BEFORE INSERT OR UPDATE OR DELETE ON partner_credit_multiunit_movements
 FOR EACH ROW EXECUTE FUNCTION pc_multiunit_evidence_inert_guard();
