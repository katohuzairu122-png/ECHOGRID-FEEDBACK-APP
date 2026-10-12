-- Disposable PostgreSQL only, migration 0044 required. No persisted writes.
-- Verify SQL guard execution, global movement idempotency and conservation metadata.
BEGIN;
DO $$
DECLARE
  trigger_blocked boolean := false;
  allocation_blocked boolean := false;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='partner_credit_multiunit_movements_idempotency_key_key'
       AND contype='u' AND conrelid='partner_credit_multiunit_movements'::regclass
  ) THEN
    RAISE EXCEPTION 'Movement idempotency UNIQUE constraint absent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='pc_multiunit_exact_conservation'
      AND contype='c' AND convalidated
      AND conrelid='partner_credit_multiunit_lot_allocations'::regclass
  ) THEN
    RAISE EXCEPTION 'Lot conservation CHECK missing or unvalidated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='pc_multiunit_movement_inert_guard'
    AND tgenabled='O'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname='pc_multiunit_allocation_inert_guard'
    AND tgenabled='O'
  ) THEN
    RAISE EXCEPTION 'Required economic inert trigger disabled';
  END IF;
  BEGIN
    INSERT INTO partner_credit_multiunit_movements
      (allocation_id,idempotency_key,source_bucket,destination_bucket,units)
    VALUES ('01234567-89ab-4def-8abc-0123456789ab','probe-only',
            'available','consumed',1);
  EXCEPTION WHEN raise_exception THEN
    trigger_blocked := true;
  END;
  IF NOT trigger_blocked THEN
    RAISE EXCEPTION 'Economic movement insert unexpectedly succeeded';
  END IF;
  BEGIN
    INSERT INTO partner_credit_multiunit_lot_allocations
      (business_id,decision_id,lot_id,account_id,allocation_key,
       units_issued,units_provisional,earning_month_utc)
    VALUES ('01234567-89ab-4def-8abc-0123456789ab',
            '01234567-89ab-4def-8abc-0123456789ab',
            '01234567-89ab-4def-8abc-0123456789ab',
            '01234567-89ab-4def-8abc-0123456789ab',
            'probe-only',3,3,'2026-10');
  EXCEPTION WHEN raise_exception THEN
    allocation_blocked := true;
  END;
  IF NOT allocation_blocked THEN
    RAISE EXCEPTION 'Economic allocation insert unexpectedly succeeded';
  END IF;
END;
$$;
ROLLBACK;
