-- HETA Block G6 (owner decision 2026-10-23): least-privilege database role architecture for the six Stripe evidence tables, with
-- defense-in-depth row-level security. NOT part of the Drizzle migration journal and NOT applied by any workflow: it is a reviewed,
-- tested asset that a database owner applies deliberately, once, per database (idempotent). It creates NOLOGIN group roles only: no login role,
-- credential, password, membership grant or connection setting is created or changed here, and nothing in the application uses these roles yet
-- (cutover to non-owner connections is a separate approval; today the application connects as the database owner, which bypasses RLS).
--
-- Roles (separation of duties; each privilege is the minimum the current modules use):
--   heta_receipt_writer    capture path: read/insert wrapped keys, receipts, malformed receipts, dispositions, conflicts, control events
--   heta_attestation       account/provider attestation: control events only
--   heta_reconciler        windowed reconciliation: read/insert events, dispositions, conflicts, control events; read keys to seal retrieved payloads
--   heta_tenant_projection NO access to any evidence table (tenant-facing projections must never read raw or quarantined evidence)
--   heta_forensic_reader   read-only on everything; its reads are recorded by inserting control events
-- Nobody gets UPDATE, DELETE or TRUNCATE (the tables are append-only; the 0045 triggers remain the authority and are untouched).
-- Existing guards and constraints (0041/0042/0044/0045/0047) are not referenced, altered, disabled or bypassed.

DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['heta_receipt_writer','heta_attestation','heta_reconciler','heta_tenant_projection','heta_forensic_reader'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', r);
    END IF;
  END LOOP;
END $$;

-- Reset, so re-running converges on exactly the matrix below.
REVOKE ALL ON TABLE stripe_evidence_control_events, stripe_evidence_keys, stripe_provider_events, stripe_provider_malformed_receipts,
  stripe_provider_event_dispositions, stripe_provider_event_conflicts
  FROM PUBLIC, heta_receipt_writer, heta_attestation, heta_reconciler, heta_tenant_projection, heta_forensic_reader;

GRANT SELECT, INSERT ON stripe_evidence_keys, stripe_provider_events, stripe_provider_malformed_receipts, stripe_provider_event_dispositions,
  stripe_provider_event_conflicts, stripe_evidence_control_events TO heta_receipt_writer;
GRANT SELECT, INSERT ON stripe_evidence_control_events TO heta_attestation;
GRANT SELECT, INSERT ON stripe_provider_events, stripe_provider_event_dispositions, stripe_provider_event_conflicts, stripe_evidence_control_events TO heta_reconciler;
GRANT SELECT ON stripe_provider_malformed_receipts, stripe_evidence_keys TO heta_reconciler;
GRANT SELECT ON stripe_evidence_keys, stripe_provider_events, stripe_provider_malformed_receipts, stripe_provider_event_dispositions,
  stripe_provider_event_conflicts, stripe_evidence_control_events TO heta_forensic_reader;
GRANT INSERT ON stripe_evidence_control_events TO heta_forensic_reader;

-- Defense in depth: with RLS enabled, a role with no matching policy sees zero rows and can insert none, even if a broad GRANT is added later by mistake.
-- The table owner still bypasses RLS (FORCE is deliberately NOT set: it would break the current owner-connected capture path).
ALTER TABLE stripe_evidence_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_evidence_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_provider_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_provider_malformed_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_provider_event_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_provider_event_conflicts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text; role text; cmd text; pol text;
  -- table | role | commands (S = SELECT, I = INSERT); mirrors the GRANTs above exactly.
  spec text[] := ARRAY[
    'stripe_evidence_keys|heta_receipt_writer|SI', 'stripe_provider_events|heta_receipt_writer|SI', 'stripe_provider_malformed_receipts|heta_receipt_writer|SI',
    'stripe_provider_event_dispositions|heta_receipt_writer|SI', 'stripe_provider_event_conflicts|heta_receipt_writer|SI', 'stripe_evidence_control_events|heta_receipt_writer|SI',
    'stripe_evidence_control_events|heta_attestation|SI',
    'stripe_provider_events|heta_reconciler|SI', 'stripe_provider_event_dispositions|heta_reconciler|SI', 'stripe_provider_event_conflicts|heta_reconciler|SI',
    'stripe_evidence_control_events|heta_reconciler|SI', 'stripe_provider_malformed_receipts|heta_reconciler|S', 'stripe_evidence_keys|heta_reconciler|S',
    'stripe_evidence_keys|heta_forensic_reader|S', 'stripe_provider_events|heta_forensic_reader|S', 'stripe_provider_malformed_receipts|heta_forensic_reader|S',
    'stripe_provider_event_dispositions|heta_forensic_reader|S', 'stripe_provider_event_conflicts|heta_forensic_reader|S', 'stripe_evidence_control_events|heta_forensic_reader|SI'
  ];
  s text; parts text[]; i int;
BEGIN
  -- drop any previous version of these policies, then recreate
  FOR t IN SELECT unnest(ARRAY['stripe_evidence_control_events','stripe_evidence_keys','stripe_provider_events','stripe_provider_malformed_receipts','stripe_provider_event_dispositions','stripe_provider_event_conflicts']) LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname LIKE 'heta\_%' LOOP
      EXECUTE format('DROP POLICY %I ON %I', pol, t);
    END LOOP;
  END LOOP;
  FOREACH s IN ARRAY spec LOOP
    parts := string_to_array(s, '|');
    t := parts[1]; role := parts[2]; cmd := parts[3];
    IF position('S' IN cmd) > 0 THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO %I USING (true)', 'heta_' || substr(role, 6) || '_select', t, role);
    END IF;
    IF position('I' IN cmd) > 0 THEN
      EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO %I WITH CHECK (true)', 'heta_' || substr(role, 6) || '_insert', t, role);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------------------------------------
-- Block G persisted tables (migration 0051). Same posture: NOLOGIN groups only, least privilege, RLS enabled (not forced), idempotent.
--   heta_reconciler  work queue: SELECT/INSERT/UPDATE (leases, retries; the 0051 guard still forbids DELETE, identity edits and any change to a terminal row),
--                    comparisons: SELECT/INSERT (immutable), revisions: SELECT/INSERT (append-only chain)
--   heta_attestation revisions: SELECT/INSERT (revoke / supersede an attestation); nothing else
--   heta_forensic_reader read-only on all three
--   heta_receipt_writer, heta_tenant_projection: no access
-- Nobody gets DELETE or TRUNCATE; comparisons and revisions get no UPDATE either. Policy names use the prefix hetag_ so the evidence-table policy reset above is untouched.
REVOKE ALL ON TABLE heta_reconciliation_work, heta_provenance_comparisons, heta_record_revisions
  FROM PUBLIC, heta_receipt_writer, heta_attestation, heta_reconciler, heta_tenant_projection, heta_forensic_reader;
GRANT SELECT, INSERT, UPDATE ON heta_reconciliation_work TO heta_reconciler;
GRANT SELECT, INSERT ON heta_provenance_comparisons, heta_record_revisions TO heta_reconciler;
GRANT SELECT, INSERT ON heta_record_revisions TO heta_attestation;
GRANT SELECT ON heta_reconciliation_work, heta_provenance_comparisons, heta_record_revisions TO heta_forensic_reader;
-- The comparison and chain triggers read stripe_provider_events / heta_record_revisions as the invoking role; heta_attestation therefore needs no evidence access
-- (its inserts only touch heta_record_revisions), and heta_reconciler already holds SELECT on stripe_provider_events.

ALTER TABLE heta_reconciliation_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE heta_provenance_comparisons ENABLE ROW LEVEL SECURITY;
ALTER TABLE heta_record_revisions ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t text; role text; cmd text; pol text; s text; parts text[];
  spec text[] := ARRAY[
    'heta_reconciliation_work|heta_reconciler|SIU', 'heta_provenance_comparisons|heta_reconciler|SI', 'heta_record_revisions|heta_reconciler|SI',
    'heta_record_revisions|heta_attestation|SI',
    'heta_reconciliation_work|heta_forensic_reader|S', 'heta_provenance_comparisons|heta_forensic_reader|S', 'heta_record_revisions|heta_forensic_reader|S'
  ];
BEGIN
  FOR t IN SELECT unnest(ARRAY['heta_reconciliation_work','heta_provenance_comparisons','heta_record_revisions']) LOOP
    FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = t AND policyname LIKE 'hetag\_%' LOOP
      EXECUTE format('DROP POLICY %I ON %I', pol, t);
    END LOOP;
  END LOOP;
  FOREACH s IN ARRAY spec LOOP
    parts := string_to_array(s, '|');
    t := parts[1]; role := parts[2]; cmd := parts[3];
    IF position('S' IN cmd) > 0 THEN EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO %I USING (true)', 'hetag_' || substr(role, 6) || '_select', t, role); END IF;
    IF position('I' IN cmd) > 0 THEN EXECUTE format('CREATE POLICY %I ON %I FOR INSERT TO %I WITH CHECK (true)', 'hetag_' || substr(role, 6) || '_insert', t, role); END IF;
    IF position('U' IN cmd) > 0 THEN EXECUTE format('CREATE POLICY %I ON %I FOR UPDATE TO %I USING (true) WITH CHECK (true)', 'hetag_' || substr(role, 6) || '_update', t, role); END IF;
  END LOOP;
END $$;
