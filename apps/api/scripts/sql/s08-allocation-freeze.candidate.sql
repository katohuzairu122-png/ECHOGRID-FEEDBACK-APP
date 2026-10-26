-- S08-DEV-05 DRAFT DDL — NOT a migration; not executed or activated.
-- Requires separately reviewed migration/journal/schema integration and PG concurrency tests.
-- Immutable invoice-bound allocation evidence, NOT financial authority.
-- Parent row stores versioned canonical artifact JSON and SHA-256; independent verifier
-- recomputes from independently authenticated invoice/reservation evidence.
CREATE TABLE IF NOT EXISTS s08_allocation_freezes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  invoice_ref text NOT NULL,
  currency text NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
  policy_version text NOT NULL CHECK (policy_version = 'S08-AGG-ROUND/1'),
  allocation_digest text NOT NULL CHECK (allocation_digest ~ '^[0-9a-f]{64}$'),
  aggregate_benefit_minor bigint NOT NULL CHECK (aggregate_benefit_minor > 0),
  reservation_count integer NOT NULL CHECK (reservation_count BETWEEN 1 AND 10),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact) = 'object'),
  provider_verified boolean NOT NULL DEFAULT false CHECK (provider_verified = false),
  consumption_authorized boolean NOT NULL DEFAULT false CHECK (consumption_authorized = false),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (business_id, invoice_ref),
  UNIQUE (id, business_id)
);

CREATE TABLE IF NOT EXISTS s08_allocation_freeze_items (
  freeze_id uuid NOT NULL,
  business_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  invoice_intent_ref text NOT NULL,
  benefit_minor bigint NOT NULL CHECK (benefit_minor > 0),
  provider_idempotency_key text NOT NULL,
  PRIMARY KEY (freeze_id, reservation_id),
  UNIQUE (reservation_id),
  UNIQUE (provider_idempotency_key),
  FOREIGN KEY (freeze_id, business_id)
    REFERENCES s08_allocation_freezes(id, business_id) ON DELETE RESTRICT,
  FOREIGN KEY (reservation_id, business_id)
    REFERENCES partner_credit_reservations(id, business_id) ON DELETE RESTRICT
);

-- Fail-closed inert storage: nobody may write until an approved guarded
-- transaction validates the complete batch and enables only that operation.
CREATE OR REPLACE FUNCTION s08_allocation_deny_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'S08_ALLOCATION_INERT';
END $$;

CREATE TRIGGER s08_allocation_parent_deny
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON s08_allocation_freezes
FOR EACH STATEMENT EXECUTE FUNCTION s08_allocation_deny_mutation();

CREATE TRIGGER s08_allocation_child_deny
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON s08_allocation_freeze_items
FOR EACH STATEMENT EXECUTE FUNCTION s08_allocation_deny_mutation();

-- This candidate does not yet have a transactional, grant-scoped append path.
-- Never remove/disable these guards simply to persist a batch.
