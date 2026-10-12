-- Run only on disposable migrated PostgreSQL test DB. Rolls back everything.
BEGIN;
DO $$
DECLARE failed boolean;
BEGIN
 -- Existing economic write guards MUST still be installed.
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='partner_credit_lots_inert_guard' AND tgenabled='O')
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='partner_credit_ledger_insert_disabled' AND tgenabled='O')
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='partner_credit_reservations_inert_guard' AND tgenabled='O')
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='pc_multiunit_allocation_inert_guard' AND tgenabled='O')
 OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='pc_multiunit_movement_inert_guard' AND tgenabled='O') THEN
   RAISE EXCEPTION 'Partner Credit economic guard missing';
 END IF;
 -- Verify database CHECK and UNIQUE coverage without introducing a path to
 -- create financial records in application databases.
 IF NOT EXISTS (SELECT 1 FROM pg_constraint
   WHERE conname='pc_multiunit_exact_conservation' AND contype='c')
 OR NOT EXISTS (SELECT 1 FROM pg_constraint
   WHERE conname='pc_multiunit_lot_once' AND contype='u')
 OR NOT EXISTS (SELECT 1 FROM pg_constraint
   WHERE conname='pc_multiunit_decision_once' AND contype='u') THEN
   RAISE EXCEPTION 'Multi-unit accounting constraints missing';
 END IF;
 PERFORM pc_multiunit_month_lock('01234567-89ab-4def-8abc-0123456789ab'::uuid,'2026-10');
 failed := false;
 BEGIN
   PERFORM pc_multiunit_month_lock('01234567-89ab-4def-8abc-0123456789ab'::uuid,'2026-13');
 EXCEPTION WHEN OTHERS THEN failed := true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'Invalid month unexpectedly accepted'; END IF;
END;
$$;
ROLLBACK;
