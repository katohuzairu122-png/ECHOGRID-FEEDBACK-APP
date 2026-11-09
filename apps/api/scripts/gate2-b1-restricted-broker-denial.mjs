/**
 * Gate 2 B1 — disposable PG18 restricted LOGIN and arbitrary SQL denial.
 * NOT a production broker, a trusted issuer, tenant authorization, or a migration.
 * CI-only credentials and synthetic table; no Neon, Hyperdrive or provider access.
 */
import assert from 'node:assert/strict';
import pg from 'pg';

const DATABASE_URL='postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_b1_broker';
if(process.env.GITHUB_ACTIONS!=='true' ||
  process.env.GATE2_B1_DISPOSABLE!=='I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
  process.env.DATABASE_URL!==DATABASE_URL) throw Error('GATE2_B1_NOT_DISPOSABLE');
const ROLE='gate2_b1_restricted_ci_login';
const PASSWORD='gate2_b1_ephemeral_ci_only';
const owner=new pg.Client({connectionString:DATABASE_URL,statement_timeout:15000});
const fail=(condition,message)=>assert.ok(condition,'GATE2_B1_'+message);
const forbidden=async(client,sql,code)=>{
  let denied=false;
  try{await client.query(sql);}catch(error){denied=['42501','0P000'].includes(error.code);}
  fail(denied,code);
};
try{
 await owner.connect();
 const info=(await owner.query("SELECT current_database() db,current_user actor,current_setting('server_version_num')::int version")).rows[0];
 fail(info.db==='echogrid_ci_pg18_b1_broker'&&info.actor==='echogrid'&&Math.floor(info.version/10000)===18,'DATABASE_IDENTITY');
 const history=(await owner.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0];
 fail(history.n===67,'MIGRATIONS_NOT_REPLAYED');

 await owner.query('CREATE SCHEMA gate2_b1');
 await owner.query('REVOKE ALL ON SCHEMA gate2_b1 FROM PUBLIC');
 await owner.query('CREATE TABLE gate2_b1.private_fixture(id integer PRIMARY KEY, status text NOT NULL)');
 await owner.query("INSERT INTO gate2_b1.private_fixture VALUES (1,'offline-only')");
 await owner.query('REVOKE ALL ON TABLE gate2_b1.private_fixture FROM PUBLIC');
 await owner.query([
  'CREATE FUNCTION gate2_b1.read_fixed_fixture() RETURNS text',
  'LANGUAGE sql STABLE SECURITY DEFINER',
  'SET search_path=pg_catalog,gate2_b1',
  "AS $$ SELECT f.status FROM gate2_b1.private_fixture f WHERE f.id=1 $$"
 ].join('\n'));
 await owner.query('REVOKE ALL ON FUNCTION gate2_b1.read_fixed_fixture() FROM PUBLIC');
 await owner.query(`CREATE ROLE ${ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${PASSWORD}'`);
 await owner.query(`GRANT USAGE ON SCHEMA gate2_b1 TO ${ROLE}`);
 await owner.query(`GRANT EXECUTE ON FUNCTION gate2_b1.read_fixed_fixture() TO ${ROLE}`);
 const url=new URL(DATABASE_URL);url.username=ROLE;url.password=PASSWORD;
 const client=new pg.Client({connectionString:url.toString(),statement_timeout:15000});
 try{
  await client.connect();
  const flags=(await client.query("SELECT rolcanlogin,rolinherit,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user")).rows[0];
  fail(flags?.rolcanlogin&&!flags.rolinherit&&!flags.rolsuper&&!flags.rolbypassrls&&!flags.rolcreaterole&&!flags.rolcreatedb&&!flags.rolreplication,'ROLE_FLAGS');
  const memberships=(await client.query('SELECT count(*)::int n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)')).rows[0].n;
  fail(memberships===0,'ROLE_MEMBERSHIP');
  const inventory=(await client.query([
   "SELECT c.relname,c.relkind,",
   "has_table_privilege(current_user,c.oid,'SELECT') s,",
   "has_table_privilege(current_user,c.oid,'INSERT') i,",
   "has_table_privilege(current_user,c.oid,'UPDATE') u,",
   "has_table_privilege(current_user,c.oid,'DELETE') d,",
   "has_table_privilege(current_user,c.oid,'TRUNCATE') t",
   "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace",
   "WHERE n.nspname='public' AND c.relkind IN ('r','p')"
  ].join(' '))).rows;
  fail(inventory.length>=90,'TABLE_COUNT');
  fail(inventory.every(row=>!row.s&&!row.i&&!row.u&&!row.d&&!row.t),'ARBITRARY_PUBLIC_TABLE_GRANT');
  const secrets=(await client.query([
   "SELECT has_table_privilege(current_user,'gate2_b1.private_fixture','SELECT') read_private,",
   "has_schema_privilege(current_user,'gate2_b1','CREATE') create_broker,",
   "has_schema_privilege(current_user,'public','CREATE') create_public,",
   "has_database_privilege(current_user,current_database(),'CREATE') create_db,",
   "has_function_privilege(current_user,'gate2_b1.read_fixed_fixture()','EXECUTE') broker_execute"
  ].join(' '))).rows[0];
  fail(!secrets.read_private&&!secrets.create_broker&&!secrets.create_public&&!secrets.create_db&&secrets.broker_execute,'PERMISSION_MATRIX');
  const sequences=(await client.query([
   "SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace",
   "WHERE n.nspname='public' AND c.relkind='S' AND (",
   "has_sequence_privilege(current_user,c.oid,'USAGE') OR",
   "has_sequence_privilege(current_user,c.oid,'SELECT') OR",
   "has_sequence_privilege(current_user,c.oid,'UPDATE'))"
  ].join(' '))).rows[0];
  fail(sequences.n===0,'PUBLIC_SEQUENCE_ACCESS');

  // Positive case is a fixed synthetic fixture only; this does NOT accept an
  // actor claim, tenant claim, request GUC, signer or authorization token.
  const allowed=await client.query('SELECT gate2_b1.read_fixed_fixture() value');
  fail(allowed.rows[0]?.value==='offline-only','BROKER_ENTRYPOINT');
  // Real arbitrary SQL denials: selecting, modifying, deleting and truncating.
  await forbidden(client,'SELECT * FROM public.businesses','DIRECT_BUSINESS_SELECT');
  await forbidden(client,'SELECT * FROM public.customers','DIRECT_CUSTOMER_SELECT');
  await forbidden(client,'SELECT * FROM public.feedback','DIRECT_FEEDBACK_SELECT');
  await forbidden(client,'SELECT * FROM public.refresh_tokens','DIRECT_SESSION_SELECT');
  await forbidden(client,'SELECT * FROM public.signed_evidence_records','DIRECT_EVIDENCE_SELECT');
  await forbidden(client,'SELECT * FROM gate2_b1.private_fixture','BROKER_TABLE_SELECT');
  await forbidden(client,"INSERT INTO gate2_b1.private_fixture(id,status) VALUES(2,'forbidden')",'BROKER_TABLE_INSERT');
  await forbidden(client,'UPDATE gate2_b1.private_fixture SET status=\'forbidden\' WHERE id=1','BROKER_TABLE_UPDATE');
  await forbidden(client,'DELETE FROM gate2_b1.private_fixture WHERE id=1','BROKER_TABLE_DELETE');
  await forbidden(client,'TRUNCATE gate2_b1.private_fixture','BROKER_TABLE_TRUNCATE');
  await forbidden(client,'CREATE TABLE public.gate2_b1_forbidden(id int)','PUBLIC_DDL');
  await forbidden(client,'CREATE TABLE gate2_b1.forbidden(id int)','BROKER_DDL');
  await forbidden(client,'CREATE SCHEMA gate2_b1_forbidden','DATABASE_DDL');
  await forbidden(client,'SET ROLE echogrid','ROLE_ESCALATION');
  // The untrusted setting must not unlock arbitrary SQL or alter broker output.
  await client.query("SELECT set_config('echogrid.tenant_id','foreign-tenant',false)");
  await forbidden(client,'SELECT * FROM public.branches','GUC_BYPASS');
  fail((await client.query('SELECT gate2_b1.read_fixed_fixture() value')).rows[0].value==='offline-only','GUC_CHANGED_FIXTURE');
  // A role must not obtain unrestricted access to existing SECURITY DEFINER
  // functions just by receiving USAGE on the new, private broker schema.
  const executable=(await client.query([
   "SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace",
   "WHERE n.nspname='public' AND p.prosecdef",
   "AND has_function_privilege(current_user,p.oid,'EXECUTE')"
  ].join(' '))).rows[0].n;
  fail(executable===0,'UNEXPECTED_EXISTING_DEFINER_EXECUTE');
  console.log(JSON.stringify({gate:'GATE2_B1_RESTRICTED_LOGIN',status:'PASS',postgresMajor:18,
   appliedMigrations:67,publicTablesChecked:inventory.length,restrictedLogin:true,
   directSqlDenied:true,roleEscalationDenied:true,objectCreationDenied:true,
   credentialScope:'DISPOSABLE_GITHUB_ACTIONS_ONLY',brokerFunction:'SYNTHETIC_FIXED_READ_ONLY',
   userIdentityVerification:'NOT_IMPLEMENTED',tenantAuthorization:'NOT_IMPLEMENTED',
   hyperdriveCertification:'NOT_PERFORMED',stagingRuntimeReady:false}));
 }finally{await client.end().catch(()=>{});}
}finally{await owner.end().catch(()=>{});}
