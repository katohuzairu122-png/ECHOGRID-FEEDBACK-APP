-- Closes L3 from the D4 independent reviews. ADDITIVE, INERT, development only; CREATE OR REPLACE of the one 0053 lot-transition function, trigger and everything else untouched.
--
-- 0053 deliberately left two lot transitions without a database evidence requirement: provisional -> consumed (the recovery-offset vest, written by
-- PartnerCreditLifecycleService.vest) and consumed -> reversed. Both writers already create their ledger evidence BEFORE the lot update (vest: applyRecoveryAtVest writes the
-- `recovery_offset` entry and the `vest` entry first; the consumed-credit compensator: obligation then `consumed_reversal` entry first), so the evidence can be required:
--   provisional -> consumed  needs a `recovery_offset` ledger entry for that decision and account;
--   consumed    -> reversed  needs a `consumed_reversal` ledger entry for that decision and account.
-- Every other rule and message of the 0053 function is unchanged (reserved -> consumed still needs a consumed reservation; nothing else may become consumed; a consumed lot can only be reversed).
CREATE OR REPLACE FUNCTION partner_credit_lot_consume_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'consumed' AND OLD.status <> 'consumed' THEN
    IF OLD.status = 'reserved' THEN
      IF NOT EXISTS (SELECT 1 FROM partner_credit_reservations r WHERE r.lot_id = NEW.id AND r.state = 'consumed') THEN
        RAISE EXCEPTION 'A reserved lot is consumed only after its reservation is consumed';
      END IF;
    ELSIF OLD.status = 'provisional' THEN
      IF NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'recovery_offset') THEN
        RAISE EXCEPTION 'A provisional lot becomes consumed only when a recovery offset absorbed its vesting unit';
      END IF;
    ELSE
      RAISE EXCEPTION 'A lot becomes consumed only from reserved (invoice consumption) or provisional (recovery-offset vest)';
    END IF;
  END IF;
  IF OLD.status = 'consumed' AND NEW.status NOT IN ('consumed','reversed') THEN
    RAISE EXCEPTION 'A consumed lot can only be reversed';
  END IF;
  IF OLD.status = 'consumed' AND NEW.status = 'reversed' THEN
    IF NOT EXISTS (SELECT 1 FROM partner_credit_ledger g WHERE g.decision_id = NEW.decision_id AND g.account_id = NEW.account_id AND g.entry_type = 'consumed_reversal') THEN
      RAISE EXCEPTION 'A consumed lot is reversed only after its consumed reversal was recorded';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
