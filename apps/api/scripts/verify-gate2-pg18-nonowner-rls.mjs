/**
 * Gate 2 R5: non-owner, non-BYPASSRLS role verification.
 * Runs ONLY against a disposable local GitHub Actions PostgreSQL 18 service.
 * Policy/catalog + empty-table authorization checks, not a live-staging audit.
 */
import pg from 'pg';

const expected = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_security';
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_R5_DISPOSABLE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    process.env.DATABASE_URL !== expected) throw new Error('GATE2_R5_TARGET_DENIED');

const admin = new pg.Client({ connectionString: expected });
const loginName = 'gate2_r5_ci_reader';
const loginPassword = 'gate2_r5_disposable_only';
const scoped = [
  { table: 'partner_credit_settlement_authorizations', role: 'settlement_tenant_reader' },
  { table: 'stripe_read_authorizations', role: 'stripe_read_auth_tenant_reader' },
  { table: 'stripe_read_authorization_events', role: 'stripe_read_auth_tenant_reader' },
];
const read = async (db, sql, values = []) => (await db.query(sql, values)).rows;
try {
  await admin.connect();
  const info = (await read(admin,
    "SELECT current_database() db, current_user AS role, current_setting('server_version_num')::int version"))[0];
  if (info.db !== 'echogrid_ci_pg18_security' || info.role !== 'echogrid' ||
      Math.floor(info.version / 10000) !== 18) throw new Error('GATE2_R5_DATABASE_MISMATCH');
  const migrations = await read(admin, 'SELECT id FROM drizzle.__drizzle_migrations');
  if (migrations.length !== 70) throw new Error('GATE2_R5_MIGRATIONS_MISSING');

  // The login is created ONLY in the disposable container, and never gets
  // the owner, superuser, BYPASSRLS, DDL or financial lifecycle role.
  await admin.query(`CREATE ROLE ${loginName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${loginPassword}'`);
  for (const role of new Set(scoped.map(x => x.role))) {
    await admin.query(`GRANT ${role} TO ${loginName} WITH INHERIT TRUE, SET FALSE`);
  }
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${loginName}`);

  const readerUrl = new URL(expected);
  readerUrl.username = loginName;
  readerUrl.password = loginPassword;
  const reader = new pg.Client({ connectionString: readerUrl.toString() });
  try {
    await reader.connect();
    const role = (await read(reader,
      'SELECT current_user AS name, rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user'))[0];
    if (role.name !== loginName || role.rolsuper || role.rolbypassrls || role.rolcreaterole)
      throw new Error('GATE2_R5_UNSAFE_RUNTIME_ROLE');
    const businesses = [
      'a4000000-0000-4000-8000-000000000001',
      'a4000000-0000-4000-8000-000000000002',
    ];
    for (const { table, role: expectedRole } of scoped) {
      const meta = (await read(reader, `
        SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
          row_security_active(c.oid) AS active,
          has_table_privilege(current_user, c.oid, 'SELECT') AS can_select,
          has_table_privilege(current_user, c.oid, 'INSERT') AS can_insert,
          has_table_privilege(current_user, c.oid, 'UPDATE') AS can_update,
          has_table_privilege(current_user, c.oid, 'DELETE') AS can_delete
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname=$1`, [table]))[0];
      if (!meta || !meta.rls || !meta.force || !meta.active ||
          !meta.can_select || meta.can_insert || meta.can_update || meta.can_delete)
        throw new Error('GATE2_R5_ROLE_PERMISSIONS_INVALID_' + table);
      const policy = (await read(reader, `
        SELECT p.polname, pg_get_expr(p.polqual, p.polrelid) AS predicate,
          pg_has_role(current_user, r.oid, 'MEMBER') AS role_member
        FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
          JOIN pg_roles r ON r.rolname=$2
        WHERE c.oid=$1::regclass::oid AND p.polcmd='r' AND r.oid = ANY(p.polroles)`,
        ['public.' + table, expectedRole])).filter(x => x.role_member &&
          x.predicate?.includes('echogrid.tenant_id') &&
          x.predicate?.includes('business_id'));
      if (policy.length !== 1) throw new Error('GATE2_R5_TENANT_POLICY_MISSING_' + table);
      // Read with unset and two different tenant contexts. This verifies the
      // effective role and guard, NOT cross-tenant row filtering (no seeded
      // financial data is created or authorized by this verification).
      for (const tenant of businesses) {
        await reader.query('BEGIN');
        try {
          await reader.query("SELECT set_config('echogrid.tenant_id', $1, true)", [tenant]);
          const active = (await read(reader, 'SELECT row_security_active($1::regclass) AS active',
            ['public.' + table]))[0];
          if (!active?.active) throw new Error('GATE2_R5_RLS_INACTIVE_' + table);
          await reader.query(`SELECT count(*)::int FROM public."${table}"`);
        } finally { await reader.query('ROLLBACK'); }
      }
    }
    console.log(JSON.stringify({
      gate: 'GATE2_R5_NONOWNER_RLS', status: 'PASS',
      pgMajor:18, requiredPolicies:scoped.length, tenantContextsChecked:2,
      nonOwnerNonBypass:true, liveStagingCertified:false,
      crossTenantDataIsolationCertified:false, backupRestoreCertified:false,
      deploymentAuthorized:false, financialAuthorization:'NOT_GRANTED',
    }));
  } finally { await reader.end().catch(() => undefined); }
} finally {
  await admin.query(`DROP ROLE IF EXISTS ${loginName}`).catch(() => undefined);
  await admin.end().catch(() => undefined);
}
