/**
 * Gate 2 R10: nonfinancial RLS candidate and adversarial trust-boundary test.
 * All DDL/DML is restricted to one disposable PostgreSQL 18 GitHub Actions DB.
 * Deliberately proves that a session GUC is spoofable by the login using it;
 * this is NOT an approved tenant context mechanism or a staging migration.
 */
import pg from 'pg';

const DB_URL = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_tenant_rls';
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_R10_DISPOSABLE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    process.env.DATABASE_URL !== DB_URL) throw new Error('GATE2_R10_NON_DISPOSABLE_TARGET_DENIED');

const role = 'gate2_r10_disposable_reader';
const password = 'gate2_r10_only_ci';
const A = 'a5000000-0000-4000-8000-000000000001';
const B = 'a5000000-0000-4000-8000-000000000002';
const tables = [
  ['businesses','id'],
  ['branches','business_id'],
  ['feedback','business_id'],
  ['surveys','business_id'],
  ['loyalty_accounts','business_id'],
];
const ids = {
  aBranch:'b5000000-0000-4000-8000-000000000001',
  bBranch:'b5000000-0000-4000-8000-000000000002',
  aQr:'e5000000-0000-4000-8000-000000000001',
  bQr:'e5000000-0000-4000-8000-000000000002',
  aFeedback:'f5000000-0000-4000-8000-000000000001',
  bFeedback:'f5000000-0000-4000-8000-000000000002',
  aSurvey:'d5000000-0000-4000-8000-000000000001',
  bSurvey:'d5000000-0000-4000-8000-000000000002',
  customer:'c5000000-0000-4000-8000-000000000001',
  aLoyalty:'95000000-0000-4000-8000-000000000001',
  bLoyalty:'95000000-0000-4000-8000-000000000002',
};
const assert = (ok, msg) => { if (!ok) throw new Error('GATE2_R10_' + msg); };
const owner = new pg.Client({ connectionString: DB_URL });
try {
  await owner.connect();
  const identity = (await owner.query(
    "SELECT current_database() AS db, current_user AS username, current_setting('server_version_num')::int AS v"
  )).rows[0];
  assert(identity.db === 'echogrid_ci_pg18_tenant_rls' && identity.username === 'echogrid' &&
    Math.floor(identity.v / 10000) === 18, 'DATABASE_IDENTITY');
  const migrations = (await owner.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations')).rows[0].n;
  assert(migrations === 72, 'INCOMPLETE_MIGRATIONS');

  for(const [table] of tables) {
    const meta=(await owner.query(`
      SELECT relrowsecurity,relforcerowsecurity FROM pg_class
      WHERE oid = $1::regclass
    `, ['public.'+table])).rows[0];
    assert(meta && !meta.relrowsecurity && !meta.relforcerowsecurity, 'BASELINE_RLS_UNEXPECTED_'+table);
  }
  // Seed only synthetic, nonfinancial fixtures using the container owner.
  await owner.query('BEGIN');
  try {
    for (const [id,suffix] of [[A,'a'],[B,'b']]) {
      await owner.query(
        'INSERT INTO public.businesses(id,name,slug) VALUES($1,$2,$3)',
        [id,'Gate2 R10 synthetic '+suffix,'gate2-r10-'+suffix],
      );
    }
    for (const [id,businessId] of [[ids.aBranch,A],[ids.bBranch,B]]) {
      await owner.query(
        'INSERT INTO public.branches(id,business_id,name,slug) VALUES($1,$2,$3,$4)',
        [id,businessId,'Synthetic R10 branch','r10-branch'],
      );
    }
    for (const [id,businessId,branchId] of [[ids.aQr,A,ids.aBranch],[ids.bQr,B,ids.bBranch]]) {
      await owner.query(
        'INSERT INTO public.qr_codes(id,business_id,branch_id) VALUES($1,$2,$3)',
        [id,businessId,branchId],
      );
    }
    for (const [id,businessId,branchId,qrCodeId,comment] of [
      [ids.aFeedback,A,ids.aBranch,ids.aQr,'R10 tenant A only'],
      [ids.bFeedback,B,ids.bBranch,ids.bQr,'R10 tenant B only'],
    ]) {
      await owner.query(
        'INSERT INTO public.feedback(id,business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,$4,5,$5)',
        [id,businessId,branchId,qrCodeId,comment],
      );
    }
    for (const [id,businessId] of [[ids.aSurvey,A],[ids.bSurvey,B]]) {
      await owner.query(
        "INSERT INTO public.surveys(id,owner_type,business_id,name) VALUES($1,'business',$2,'Synthetic R10 survey')",
        [id,businessId],
      );
    }
    // One global customer identity with separate business-owned memberships.
    await owner.query('INSERT INTO public.customers(id,phone) VALUES($1,$2)',[ids.customer,'+15550009110']);
    for (const [id,businessId] of [[ids.aLoyalty,A],[ids.bLoyalty,B]]) {
      await owner.query(
        'INSERT INTO public.loyalty_accounts(id,customer_id,business_id) VALUES($1,$2,$3)',
        [id,ids.customer,businessId],
      );
    }
    await owner.query('COMMIT');
  } catch(e) {await owner.query('ROLLBACK');throw e;}

  // Only temporary CI changes; NO Drizzle migration or live schema amendment.
  await owner.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER
    NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
  await owner.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  for (const [table,column] of tables) {
    await owner.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`);
    await owner.query(`ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY`);
    // NULL or missing tenant setting denies all rows; platform-owned surveys
    // (business_id NULL) are excluded from a business-scoped reader.
    await owner.query(`
      CREATE POLICY gate2_r10_candidate_select ON public."${table}"
      FOR SELECT TO ${role}
      USING ("${column}"::text = NULLIF(current_setting('echogrid.tenant_id',true),''))
    `);
    await owner.query(`GRANT SELECT ON TABLE public."${table}" TO ${role}`);
  }
  const candidateUrl = new URL(DB_URL);
  candidateUrl.username=role;candidateUrl.password=password;
  const reader = new pg.Client({ connectionString:candidateUrl.toString() });
  try {
    await reader.connect();
    const flags=(await reader.query(`
      SELECT rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb
      FROM pg_roles WHERE rolname=current_user
    `)).rows[0];
    assert(flags?.rolcanlogin && !flags.rolsuper && !flags.rolbypassrls &&
      !flags.rolcreaterole && !flags.rolcreatedb,'PRIVILEGED_ROLE');
    for (const [table] of tables) {
      const p=(await reader.query(`
        SELECT has_table_privilege(current_user,$1::regclass,'SELECT') AS can_read,
          has_table_privilege(current_user,$1::regclass,'INSERT') AS can_insert,
          has_table_privilege(current_user,$1::regclass,'UPDATE') AS can_update,
          has_table_privilege(current_user,$1::regclass,'DELETE') AS can_delete,
          row_security_active($1::regclass) AS active
      `, ['public.'+table])).rows[0];
      assert(p.can_read && p.active && !p.can_insert && !p.can_update && !p.can_delete,
        'ROLE_PERMISSION_'+table);
    }
    async function checkContext(tenant,expected) {
      await reader.query('BEGIN');
      try {
        if(tenant !== null) {
          await reader.query("SELECT set_config('echogrid.tenant_id',$1,true)",[tenant]);
        }
        for(const [table] of tables) {
          const result=(await reader.query(`SELECT count(*)::int AS n FROM public."${table}"`)).rows[0].n;
          assert(result===expected,'ROW_SCOPE_'+table+'_'+String(tenant));
        }
      } finally {await reader.query('ROLLBACK');}
    }
    await checkContext(null,0);
    await checkContext(A,1);
    await checkContext(B,1);
    // A fresh transaction after ROLLBACK must not inherit prior tenant.
    await checkContext(null,0);
    // Demonstrates critical limitation: a normal SQL login can set an
    // arbitrary custom GUC. RLS policies based ONLY on this setting do not
    // independently authenticate a business or enforce per-user membership.
    await reader.query('BEGIN');
    let spoofSucceeded=false;
    try {
      await reader.query("SELECT set_config('echogrid.tenant_id',$1,true)",[B]);
      const count=(await reader.query(
        'SELECT count(*)::int AS n FROM public.feedback WHERE business_id=$1',[B],
      )).rows[0].n;
      spoofSucceeded = count === 1;
    } finally {await reader.query('ROLLBACK');}
    assert(spoofSucceeded,'GUC_SPOOFABILITY_NOT_DEMONSTRATED');
    const crossWrite=await reader.query(`
      SELECT has_table_privilege(current_user,'public.feedback'::regclass,'UPDATE') AS can_update
    `);
    assert(!crossWrite.rows[0].can_update,'WRITE_PRIVILEGE_EXPOSED');
    console.log(JSON.stringify({
      gate:'GATE2_R10_DISPOSABLE_NONFINANCIAL_RLS',
      policyExercise:'PASS',
      stagingCertification:'BLOCKED',
      reason:'UNTRUSTED_CUSTOM_GUC_CAN_BE_SPOOFED_BY_DATABASE_LOGIN',
      postgresMajor:18,migrations:72,tablesChecked:tables.length,
      tenantAVisiblePerTable:1,tenantBVisiblePerTable:1,
      missingTenantVisiblePerTable:0,transactionReset:'PASS',
      unauthorizedTenantSelectionPossible:true,
      runtimeRoleReady:false,hyperdriveChanged:false,
      liveNeonChanged:false,financialAuthorization:'NOT_GRANTED',
    }));
  } finally {await reader.end().catch(()=>undefined);}
} finally {
  // Entire disposable container disappears at job completion.
  await owner.end().catch(()=>undefined);
}
