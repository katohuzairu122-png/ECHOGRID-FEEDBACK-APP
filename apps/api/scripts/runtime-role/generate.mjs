/**
 * R8-G: generates the runtime-role provisioning and verification SQL from runtime-role-manifest.json (the reviewed source of truth).
 *   node scripts/runtime-role/generate.mjs           -> writes the two .sql files
 *   node scripts/runtime-role/generate.mjs --check   -> exits 1 if the committed files differ (CI/test drift guard)
 * The SQL contains NO secrets, NO password and NO login name: the login role is created by the operator out of band and named by placeholder.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, 'runtime-role-manifest.json'), 'utf8'));
const ROLE = manifest.role;
if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) throw new Error('RUNTIME_ROLE_NAME_INVALID');
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`IDENT_INVALID:${s}`); return s; };

const runtime = Object.entries(manifest.tables).filter(([, m]) => m.class === 'RUNTIME').sort(([a], [b]) => a.localeCompare(b));
const noAccess = Object.entries(manifest.tables).filter(([, m]) => m.class === 'NO_ACCESS').map(([t]) => ident(t)).sort();
const VERBS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
for (const [t, m] of runtime) {
  ident(t);
  if (!m.verbs.length || m.verbs.some((v) => !VERBS.has(v))) throw new Error(`VERBS_INVALID:${t}`);
}

const header = (what) => `-- ${what}
-- GENERATED from scripts/runtime-role/runtime-role-manifest.json by scripts/runtime-role/generate.mjs. DO NOT EDIT BY HAND.
-- Contains no secret, no password and no real login name. NOT part of the Drizzle journal: it is run by the schema owner (migration
-- authority) after migrations, in a controlled workflow. It has NOT been run against staging or production.
`;

const provisioning = `${header('R8-G: provision the least-privilege application runtime role (idempotent)')}
-- Run as the schema OWNER / migrator. Before running, create the application LOGIN out of band (the password never appears in this repository):
--   CREATE ROLE <runtime_login> LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- then replace REPLACE_WITH_RUNTIME_LOGIN below with that name (or pass it through your provisioning tool).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
    CREATE ROLE ${ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
-- A non-superuser owner (the production migrator) may not run ALTER ROLE with NOSUPERUSER / NOBYPASSRLS / NOREPLICATION even to restate a value, so
-- the attributes are VERIFIED, not altered: a pre-existing role with any dangerous attribute stops the script.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolcanlogin)) THEN
    RAISE EXCEPTION 'R8G: role ${ROLE} exists with unsafe attributes (superuser, BYPASSRLS, CREATEROLE, CREATEDB, REPLICATION or LOGIN); refusing to continue';
  END IF;
END
$$;

-- No ownership and no object creation: usage only.
REVOKE ALL ON SCHEMA public FROM ${ROLE};
GRANT USAGE ON SCHEMA public TO ${ROLE};

-- Tables the runtime may use, with exactly the verbs the application code uses (see the manifest). Everything else gets nothing.
-- Tables that do not exist yet in the target database are skipped, so the script is safe at any migration level.
DO $$
DECLARE
  rec record;
  grants text[][] := ARRAY[
${runtime.map(([t, m]) => `    ['${t}', '${m.verbs.join(', ')}']`).join(',\n')}
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(grants, 1) LOOP
    IF to_regclass('public.' || grants[i][1]) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${ROLE}', grants[i][1]);
      EXECUTE format('GRANT %s ON TABLE public.%I TO ${ROLE}', grants[i][2], grants[i][1]);
    END IF;
  END LOOP;
END
$$;

-- Tables the runtime must NOT touch (dedicated-role families, operator-only tables, dormant tables): explicitly revoked.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[${noAccess.map((t) => `'${t}'`).join(', ')}] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${ROLE}', t);
    END IF;
  END LOOP;
END
$$;

-- Sequences used by the tables above (ids); nothing else.
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY[${manifest.sequences.map((s) => `'${ident(s)}'`).join(', ')}] LOOP
    IF to_regclass('public.' || s) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE public.%I FROM ${ROLE}', s);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO ${ROLE}', s);
    END IF;
  END LOOP;
END
$$;

-- Attach the login. INHERIT is required for the login to use the group's grants; the group is a member of nothing.
GRANT ${ROLE} TO REPLACE_WITH_RUNTIME_LOGIN;
`;

const verification = `${header('R8-G: verify the runtime role. EVERY query must return ZERO rows; any row is a violation.')}
-- Run as the schema owner. :runtime_login is the application login (psql: -v runtime_login=...).

-- V1 role attributes: no superuser, createdb, createrole, replication, bypassrls (group and login).
SELECT rolname, 'DANGEROUS_ATTRIBUTE' AS violation FROM pg_roles
 WHERE rolname IN ('${ROLE}', :'runtime_login') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);

-- V2 memberships: the group must be a member of nothing; the login may be a member of the group only.
SELECT r.rolname AS member, g.rolname AS granted_role, 'UNEXPECTED_MEMBERSHIP' AS violation
  FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
 WHERE r.rolname IN ('${ROLE}', :'runtime_login') AND NOT (r.rolname = :'runtime_login' AND g.rolname = '${ROLE}');

-- V3 ownership: the runtime owns nothing in the application schema (no tables, functions, sequences, schemas).
SELECT 'table' AS kind, c.relname AS name, 'RUNTIME_OWNS_OBJECT' AS violation FROM pg_class c
  JOIN pg_roles o ON o.oid = c.relowner WHERE o.rolname IN ('${ROLE}', :'runtime_login') AND c.relnamespace = 'public'::regnamespace
UNION ALL SELECT 'function', p.proname, 'RUNTIME_OWNS_OBJECT' FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
  WHERE o.rolname IN ('${ROLE}', :'runtime_login') AND p.pronamespace = 'public'::regnamespace
UNION ALL SELECT 'schema', n.nspname, 'RUNTIME_OWNS_OBJECT' FROM pg_namespace n JOIN pg_roles o ON o.oid = n.nspowner
  WHERE o.rolname IN ('${ROLE}', :'runtime_login');

-- V4 no object creation in the schema or the database.
SELECT 'schema_create' AS kind, 'public' AS name, 'RUNTIME_CAN_CREATE' AS violation WHERE has_schema_privilege(:'runtime_login', 'public', 'CREATE')
UNION ALL SELECT 'database_create', current_database(), 'RUNTIME_CAN_CREATE' WHERE has_database_privilege(:'runtime_login', current_database(), 'CREATE');
-- Accepted residual (documented, not a violation): TEMPORARY is granted to PUBLIC by PostgreSQL by default and cannot be revoked from one role.
-- Temporary objects are private to the session and cannot affect any shared object.

-- V5 table privileges: TRUNCATE, TRIGGER, REFERENCES nowhere; and no verb beyond the manifest on any table.
SELECT c.relname AS name, v.verb, 'PRIVILEGE_OUTSIDE_MANIFEST' AS violation
  FROM pg_class c CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) v(verb)
 WHERE c.relkind IN ('r', 'p') AND c.relnamespace = 'public'::regnamespace AND has_table_privilege(:'runtime_login', c.oid, v.verb)
   AND NOT EXISTS (SELECT 1 FROM (VALUES
${runtime.flatMap(([t, m]) => m.verbs.map((v) => `       ('${t}', '${v}')`)).join(',\n')}
     ) allowed(tbl, verb) WHERE allowed.tbl = c.relname AND allowed.verb = v.verb);

-- V6 no privileged definer function is executable by the runtime (EXECUTE via PUBLIC counts).
SELECT p.proname AS name, 'DEFINER_FUNCTION_EXECUTABLE' AS violation FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef AND has_function_privilege(:'runtime_login', p.oid, 'EXECUTE');

-- V7 sequences: only the manifest's.
SELECT c.relname AS name, 'SEQUENCE_OUTSIDE_MANIFEST' AS violation FROM pg_class c
 WHERE c.relkind = 'S' AND c.relnamespace = 'public'::regnamespace
   AND (has_sequence_privilege(:'runtime_login', c.oid, 'USAGE') OR has_sequence_privilege(:'runtime_login', c.oid, 'UPDATE'))
   AND c.relname NOT IN (${manifest.sequences.map((s) => `'${s}'`).join(', ')});
`;

const files = {
  'provision-runtime-role.sql': provisioning,
  'verify-runtime-role.sql': verification,
};
const check = process.argv.includes('--check');
let drift = false;
for (const [name, body] of Object.entries(files)) {
  const path = join(here, name);
  if (check) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (current !== body) { console.error(`DRIFT: ${name}`); drift = true; }
  } else {
    writeFileSync(path, body);
    console.log(`wrote ${name}`);
  }
}
if (drift) process.exit(1);
