-- Split 07 Block 1: inert Partner Credit foundations; no award/Stripe triggers.
CREATE TABLE partner_program_enrollments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 status text NOT NULL CHECK (status IN ('active','suspended','left')), policy_version text NOT NULL,
 accepted_by_user_id uuid REFERENCES users(id) ON DELETE RESTRICT, accepted_at timestamptz NOT NULL, effective_at timestamptz NOT NULL, suspended_at timestamptz,
 CONSTRAINT partner_enrollments_business_key UNIQUE (business_id)
);
--> statement-breakpoint
CREATE TABLE partner_credit_policies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), version text NOT NULL UNIQUE,
 state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','active','retired')),
 award_units integer NOT NULL DEFAULT 1, monthly_cap integer NOT NULL DEFAULT 10,
 vest_days integer NOT NULL DEFAULT 14, expires_after_months integer NOT NULL DEFAULT 12,
 effective_at timestamptz, retired_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT partner_credit_policies_positive_check CHECK (award_units > 0 AND monthly_cap > 0 AND vest_days > 0 AND expires_after_months > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX partner_credit_one_active_policy_idx ON partner_credit_policies(state) WHERE state = 'active';
--> statement-breakpoint
CREATE TABLE partner_credit_accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 available integer NOT NULL DEFAULT 0, provisional integer NOT NULL DEFAULT 0,
 reserved integer NOT NULL DEFAULT 0, recovery_due integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT partner_credit_accounts_business_key UNIQUE (business_id),
 CONSTRAINT partner_credit_account_nonnegative_check CHECK (available >= 0 AND provisional >= 0 AND reserved >= 0 AND recovery_due >= 0)
);
--> statement-breakpoint
CREATE TABLE partner_credit_award_decisions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 settlement_ref uuid NOT NULL REFERENCES orphan_settlements(id) ON DELETE RESTRICT,
 business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
 policy_id uuid NOT NULL REFERENCES partner_credit_policies(id) ON DELETE RESTRICT,
 state text NOT NULL CHECK (state IN ('ineligible','cap_exceeded','provisional','vested','reversed')),
 award_units integer NOT NULL CHECK (award_units >= 0),
 earning_month_utc text NOT NULL CHECK (earning_month_utc ~ '^[0-9]{4}-[0-9]{2}$'),
 fulfilled_at timestamptz NOT NULL, vest_at timestamptz,
 idempotency_key text NOT NULL,
 decided_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT partner_credit_awards_settlement_key UNIQUE (settlement_ref),
 CONSTRAINT partner_credit_awards_idempotency_key UNIQUE (idempotency_key)
);
--> statement-breakpoint
CREATE INDEX partner_credit_awards_business_month_idx ON partner_credit_award_decisions(business_id,earning_month_utc);
--> statement-breakpoint
CREATE TABLE partner_credit_lots (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 decision_id uuid NOT NULL REFERENCES partner_credit_award_decisions(id) ON DELETE RESTRICT,
 account_id uuid NOT NULL REFERENCES partner_credit_accounts(id) ON DELETE RESTRICT,
 units integer NOT NULL, available_units integer NOT NULL DEFAULT 0,
 status text NOT NULL CHECK (status IN ('provisional','available','reserved','consumed','expired','reversed')),
 vest_at timestamptz NOT NULL, expires_at timestamptz,
 CONSTRAINT partner_credit_lots_decision_key UNIQUE (decision_id),
 CONSTRAINT partner_credit_lots_units_check CHECK (units > 0 AND available_units >= 0 AND available_units <= units)
);
--> statement-breakpoint
CREATE TABLE partner_credit_ledger (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES partner_credit_accounts(id) ON DELETE RESTRICT,
 decision_id uuid REFERENCES partner_credit_award_decisions(id) ON DELETE RESTRICT,
 entry_type text NOT NULL CHECK (entry_type IN ('provisional','vest','expire','reverse','recovery_offset','admin_adjustment')),
 units integer NOT NULL CHECK (units <> 0), idempotency_key text NOT NULL UNIQUE,
 metadata jsonb, occurred_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX partner_credit_ledger_account_date_idx ON partner_credit_ledger(account_id,occurred_at);
--> statement-breakpoint
CREATE TABLE partner_credit_recovery_obligations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES partner_credit_accounts(id) ON DELETE RESTRICT,
 reversal_ref uuid NOT NULL UNIQUE,
 units_due integer NOT NULL, units_outstanding integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT partner_credit_recovery_units_check CHECK (units_due > 0 AND units_outstanding >= 0 AND units_outstanding <= units_due)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION partner_credit_ledger_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Partner Credit ledger is append-only'; END;
$$;
--> statement-breakpoint
CREATE TRIGGER partner_credit_ledger_no_update_delete BEFORE UPDATE OR DELETE ON partner_credit_ledger FOR EACH ROW EXECUTE FUNCTION partner_credit_ledger_immutable();
