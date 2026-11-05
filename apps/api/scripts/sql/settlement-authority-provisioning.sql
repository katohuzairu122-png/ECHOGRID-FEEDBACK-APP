-- D1/D3-DEV-05: reviewed, TEMPLATE provisioning of the settlement-authority roles' MEMBERS. NOT part of the Drizzle migration journal and NOT applied by any workflow or by anything in this repository:
-- a database owner reads it, edits the two names below, and applies it deliberately, once per database (idempotent). It creates NO login role, password, credential or key, and changes no table, policy,
-- function or setting. The group roles it uses (settlement_recorder, settlement_consumer, ...) are created, NOLOGIN, by migration 0061.
--
-- What it does, and nothing else:
--   * makes the APPLICATION login a member of settlement_consumer, with INHERIT: it may EXECUTE the verification function, and has no table privilege of its own through that role.
--   * makes the RECORDER login a member of settlement_recorder WITHOUT inheriting it (INHERIT FALSE, SET TRUE): the recorder session holds no recording privilege until the recorder code
--     explicitly switches to the role for its single INSERT, and a session that never switches can never insert.
--   * refuses to continue if either name is unset, does not exist, cannot log in, is a superuser or has BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION, if the two are the same login, or if either
--     already holds the OTHER duty (separation of duties: whoever verifies must not be able to record, and the reverse), or already holds any other settlement role.
--
-- Not covered here, and not decided here: creating the login roles and their credentials, the recorder's private signing key and its custody, key rotation procedure, network access.
--
-- USAGE (psql or any client; edit the two literals first):
SELECT set_config('settlement.app_login', 'REPLACE_WITH_APPLICATION_LOGIN', false);
SELECT set_config('settlement.recorder_login', 'REPLACE_WITH_RECORDER_LOGIN', false);

DO $$
DECLARE
  app_login text := current_setting('settlement.app_login', true);
  rec_login text := current_setting('settlement.recorder_login', true);
  who text;
  unsafe record;
BEGIN
  IF app_login IS NULL OR rec_login IS NULL OR app_login = '' OR rec_login = '' OR app_login LIKE 'REPLACE\_WITH\_%' OR rec_login LIKE 'REPLACE\_WITH\_%' THEN
    RAISE EXCEPTION 'PROVISIONING: both login names must be set (settlement.app_login, settlement.recorder_login)';
  END IF;
  IF app_login = rec_login THEN
    RAISE EXCEPTION 'PROVISIONING: the application login and the recorder login must be different roles (separation of duties)';
  END IF;
  FOREACH who IN ARRAY ARRAY[app_login, rec_login] LOOP
    SELECT * INTO unsafe FROM pg_roles WHERE rolname = who;
    IF NOT FOUND THEN RAISE EXCEPTION 'PROVISIONING: role % does not exist (this script does not create logins)', who; END IF;
    IF NOT unsafe.rolcanlogin THEN RAISE EXCEPTION 'PROVISIONING: role % cannot log in; it must be a login role', who; END IF;
    IF unsafe.rolsuper OR unsafe.rolbypassrls OR unsafe.rolcreaterole OR unsafe.rolcreatedb OR unsafe.rolreplication THEN
      RAISE EXCEPTION 'PROVISIONING: role % has superuser, BYPASSRLS, CREATEROLE, CREATEDB or REPLICATION', who;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
                WHERE m.member = unsafe.oid AND g.rolname IN ('settlement_authority_reader', 'settlement_tenant_reader', 'settlement_auditor')) THEN
      RAISE EXCEPTION 'PROVISIONING: role % already holds an internal or read-only settlement role', who;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = app_login) AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'settlement_recorder')) THEN
    RAISE EXCEPTION 'PROVISIONING: the application login % already holds settlement_recorder', app_login;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = (SELECT oid FROM pg_roles WHERE rolname = rec_login) AND m.roleid = (SELECT oid FROM pg_roles WHERE rolname = 'settlement_consumer')) THEN
    RAISE EXCEPTION 'PROVISIONING: the recorder login % already holds settlement_consumer', rec_login;
  END IF;
  EXECUTE format('GRANT settlement_consumer TO %I WITH INHERIT TRUE, SET FALSE', app_login);
  EXECUTE format('GRANT settlement_recorder TO %I WITH INHERIT FALSE, SET TRUE', rec_login);
END $$;
