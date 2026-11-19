-- CASHIER-PROD-RELEASE-P1: NARROW production provisioning of the `cashier:manage` permission. REVIEW ONLY. NOT EXECUTED anywhere but a
-- local rehearsal database. Run only at gate P4, after migrations 0080-0083 are applied and verified, and only with the Owner's explicit
-- authorization. It does NOT use db:backfill-role-permissions or db:seed.
--
-- Scope (exactly): one permission row, and its grant to the SYSTEM roles named Owner and Admin of ONE named business.
-- Never touched: any other permission, any other role (Manager, Staff, custom roles, Cashier), any other business, any user, any grant row.
--
-- Usage (psql, as the production database owner; the business id is verified by the Owner first, never guessed):
--   psql "$PRODUCTION_URL" -v ON_ERROR_STOP=1 -v business_id='<verified business uuid>' -f CASHIER_PROD_P4_cashier_manage_provisioning.sql
-- Everything below is one transaction: any failed assertion rolls ALL of it back. Re-running is a no-op (idempotent).

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TEMP TABLE p4_target ON COMMIT DROP AS SELECT :'business_id'::uuid AS business_id;
CREATE TEMP TABLE p4_before ON COMMIT DROP AS
  SELECT (SELECT count(*) FROM permissions) AS perms,
         (SELECT count(*) FROM role_permissions) AS grants,
         (SELECT count(*) FROM permissions WHERE key <> 'cashier:manage') AS other_perms,
         (SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.key <> 'cashier:manage') AS other_grants;

-- Preconditions: the cashier schema exists, the business exists and is active, and it has exactly one live system Owner and Admin role.
DO $$
DECLARE t uuid := (SELECT business_id FROM p4_target);
BEGIN
  IF to_regclass('public.customer_onboarding_events') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'managed_business_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'businesses' AND column_name = 'cashier_code') THEN
    RAISE EXCEPTION 'P4 precondition failed: migrations 0082/0083 are not applied';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM businesses WHERE id = t AND status = 'active' AND NOT is_deleted) THEN
    RAISE EXCEPTION 'P4 precondition failed: the business is not an active business';
  END IF;
  IF (SELECT count(*) FROM roles WHERE business_id = t AND is_system AND NOT is_deleted AND name = 'Owner') <> 1
     OR (SELECT count(*) FROM roles WHERE business_id = t AND is_system AND NOT is_deleted AND name = 'Admin') <> 1 THEN
    RAISE EXCEPTION 'P4 precondition failed: the business does not have exactly one live system Owner role and one live system Admin role';
  END IF;
END $$;

-- 1. The catalog entry (same key, description and category as apps/api/src/db/seed/permissions.seed.ts). Idempotent.
INSERT INTO permissions (key, description, category)
VALUES ('cashier:manage',
        'Create and manage business-managed cashier accounts (credentials, status, sessions, business code). Business-wide access only; granted to Owner and Admin by default, never to Manager unless the Owner grants it.',
        'Cashier accounts')
ON CONFLICT (key) DO NOTHING;

-- 2. The grant, to the live SYSTEM Owner and Admin roles of the target business only. Idempotent.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.key = 'cashier:manage'
JOIN p4_target t ON t.business_id = r.business_id
WHERE r.is_system AND NOT r.is_deleted AND r.name IN ('Owner', 'Admin')
ON CONFLICT DO NOTHING;

-- Assertions (any failure rolls back everything).
DO $$
DECLARE t uuid := (SELECT business_id FROM p4_target);
BEGIN
  IF (SELECT count(*) FROM permissions WHERE key = 'cashier:manage') <> 1 THEN RAISE EXCEPTION 'P4 assertion failed: the permission must exist exactly once'; END IF;
  IF (SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id
      WHERE p.key = 'cashier:manage' AND r.business_id = t AND r.is_system AND NOT r.is_deleted AND r.name IN ('Owner', 'Admin')) <> 2 THEN
    RAISE EXCEPTION 'P4 assertion failed: exactly the live system Owner and Admin roles of the business must hold the permission';
  END IF;
  IF EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id JOIN roles r ON r.id = rp.role_id
             WHERE p.key = 'cashier:manage' AND NOT (r.business_id = t AND r.is_system AND NOT r.is_deleted AND r.name IN ('Owner', 'Admin'))) THEN
    RAISE EXCEPTION 'P4 assertion failed: some other role holds the permission (Manager, Staff, a custom role, another business or a deleted role)';
  END IF;
  IF (SELECT other_perms FROM p4_before) <> (SELECT count(*) FROM permissions WHERE key <> 'cashier:manage')
     OR (SELECT other_grants FROM p4_before) <> (SELECT count(*) FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE p.key <> 'cashier:manage') THEN
    RAISE EXCEPTION 'P4 assertion failed: an existing permission or grant changed';
  END IF;
END $$;

-- Evidence to record (counts only).
SELECT (SELECT count(*) FROM permissions) - (SELECT perms FROM p4_before) AS permissions_added,
       (SELECT count(*) FROM role_permissions) - (SELECT grants FROM p4_before) AS grants_added;
SELECT r.name AS role, bool_or(p.key = 'cashier:manage') AS holds_cashier_manage
FROM roles r
LEFT JOIN role_permissions rp ON rp.role_id = r.id
LEFT JOIN permissions p ON p.id = rp.permission_id
WHERE r.business_id = (SELECT business_id FROM p4_target) AND r.is_system AND NOT r.is_deleted
GROUP BY r.name ORDER BY r.name;

COMMIT;
