/**
 * Gate 2 R9 — disposable-only least-privilege runtime candidate contract.
 * This does NOT provision a usable application runtime login or modify Neon.
 * A candidate with unscoped tenant-table SELECT is NOT acceptable while
 * database RLS and application role semantics remain unresolved.
 */
import pg from 'pg';

const EXPECTED_URL = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_role_contract';
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_R9_DISPOSABLE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    process.env.DATABASE_URL !== EXPECTED_URL) {
  throw new Error('GATE2_R9_NON_DISPOSABLE_TARGET_DENIED');
}
const candidateName = 'gate2_r9_disposable_candidate';
const candidatePassword = 'gate2_r9_ci_never_use_live';
const owner = new pg.Client({ connectionString: EXPECTED_URL });
const assert = (condition, code) => { if (!condition) throw new Error('GATE2_R9_' + code); };
try {
  await owner.connect();
  const identity = (await owner.query(
    "SELECT current_database() db, current_user role, current_setting('server_version_num')::int version",
  )).rows[0];
  assert(identity.db === 'echogrid_ci_pg18_role_contract' &&
    identity.role === 'echogrid' && Math.floor(identity.version / 10000) === 18,
    'TARGET_MISMATCH');
  const applied = (await owner.query(
    'SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations',
  )).rows[0];
  assert(applied.count === 71, 'MIGRATIONS_NOT_REPLAYED');

  await owner.query(`CREATE ROLE ${candidateName} LOGIN INHERIT NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD '${candidatePassword}'`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${candidateName}`);
  const loginUrl = new URL(EXPECTED_URL);
  loginUrl.username = candidateName;
  loginUrl.password = candidatePassword;
  const candidate = new pg.Client({ connectionString: loginUrl.toString() });
  try {
    await candidate.connect();
    const flags = (await candidate.query(
      "SELECT rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication FROM pg_roles WHERE rolname=current_user",
    )).rows[0];
    assert(flags?.rolcanlogin && !flags.rolsuper && !flags.rolbypassrls &&
      !flags.rolcreatedb && !flags.rolcreaterole && !flags.rolreplication,
      'PRIVILEGE_FLAGS');
    const memberships = (await candidate.query(`
      SELECT granted.rolname FROM pg_auth_members m
      JOIN pg_roles member ON member.oid=m.member
      JOIN pg_roles granted ON granted.oid=m.roleid
      WHERE member.rolname=current_user
    `)).rows;
    assert(memberships.length === 0, 'PRIVILEGED_MEMBERSHIP');

    const privileges = (await candidate.query(`
      SELECT c.relname,
        has_table_privilege(current_user,c.oid,'SELECT') AS can_read,
        has_table_privilege(current_user,c.oid,'INSERT') AS can_insert,
        has_table_privilege(current_user,c.oid,'UPDATE') AS can_update,
        has_table_privilege(current_user,c.oid,'DELETE') AS can_delete,
        c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
    `)).rows;
    assert(privileges.length >= 69, 'TABLE_INVENTORY');
    assert(privileges.every(p=>!p.can_read && !p.can_insert && !p.can_update && !p.can_delete),
      'UNEXPECTED_TABLE_GRANT');
    const catalog = new Map(privileges.map(p=>[p.relname,p]));
    for(const table of ['businesses','branches','feedback','surveys','loyalty_accounts',
      'partner_credit_settlement_authorizations','stripe_read_authorizations',
      'signed_evidence_records']) {
      assert(catalog.has(table), 'MISSING_PROTECTED_TABLE_' + table);
    }
    for(const table of ['businesses','branches','feedback','surveys','loyalty_accounts']) {
      assert(!catalog.get(table).rls && !catalog.get(table).forced,
        'NONFINANCIAL_RLS_CONTRACT_CHANGED_' + table);
    }
    for(const table of ['partner_credit_settlement_authorizations',
      'stripe_read_authorizations','signed_evidence_records']) {
      assert(catalog.get(table).rls && catalog.get(table).forced,
        'FINANCIAL_FORCE_RLS_MISSING_' + table);
    }
    const ddl = (await candidate.query(`
      SELECT has_schema_privilege(current_user,'public','CREATE') AS can_create
    `)).rows[0];
    assert(!ddl.can_create,'SCHEMA_CREATE_GRANT');
    const sequences = (await candidate.query(`
      SELECT n.nspname,c.relname,
        has_sequence_privilege(current_user,c.oid,'USAGE') AS usage,
        has_sequence_privilege(current_user,c.oid,'SELECT') AS can_read,
        has_sequence_privilege(current_user,c.oid,'UPDATE') AS can_update
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S'
    `)).rows;
    assert(sequences.every(s=>!s.usage && !s.can_read && !s.can_update),
      'UNEXPECTED_SEQUENCE_GRANT');
    const sensitive = [
      'public.stripe_read_auth_propose(uuid,text,text,text,bigint,bigint,uuid,text,text)',
      'public.stripe_read_auth_approve(uuid,uuid,text)',
      'public.evidence_custody_fetch(uuid,uuid,text)',
    ];
    for(const signature of sensitive) {
      const grant = (await candidate.query(
        "SELECT has_function_privilege(current_user,$1::regprocedure,'EXECUTE') AS executable",
        [signature],
      )).rows[0];
      assert(!grant.executable,'SENSITIVE_FUNCTION_EXPOSED');
    }
    // This is an intentionally unusable role. If a future change grants
    // cross-tenant business table access, the preflight must fail.
    console.log(JSON.stringify({
      gate:'GATE2_R9_DISPOSABLE_RUNTIME_ROLE_CONTRACT',
      test:'least_privilege_negative_capabilities',
      status:'PASS',
      certification:'BLOCKED',
      reason:'BUSINESS_TABLE_RLS_AND_RUNTIME_ACCESS_CONTRACT_NOT_READY',
      postgresMajor:18,
      appliedMigrations:applied.count,
      publicTables:privileges.length,
      nonfinancialTenantTablesWithoutRls:5,
      prohibitedTableGrants:0,
      prohibitedSequenceGrants:0,
      candidateCanServeApplication:false,
      stagingRuntimeRoleChanged:false,
      cloudflareHyperdriveChanged:false,
      financialAuthorization:'NOT_GRANTED',
    }));
  } finally {
    await candidate.end().catch(()=>undefined);
  }
} finally {
  await owner.query(`DROP ROLE IF EXISTS ${candidateName}`).catch(()=>undefined);
  await owner.end().catch(()=>undefined);
}
