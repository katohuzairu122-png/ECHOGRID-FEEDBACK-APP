/**
 * Gate 2 R11 — prove non-spoofable tenant binding using PostgreSQL session_user.
 *
 * Disposable CI only. Creates two isolated per-business DB principals,
 * an owner-controlled identity mapping and five table RLS SELECT policies.
 * No Drizzle migrations, Neon SQL, Hyperdrive config or runtime app grants.
 */
import pg from 'pg';

const DB_URL='postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_principal';
if(process.env.GITHUB_ACTIONS!=='true' ||
   process.env.GATE2_R11_DISPOSABLE!=='I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
   process.env.DATABASE_URL!==DB_URL) throw Error('GATE2_R11_NON_DISPOSABLE_TARGET_DENIED');

const a='a6000000-0000-4000-8000-000000000001';
const b='a6000000-0000-4000-8000-000000000002';
const customer='c6000000-0000-4000-8000-000000000001';
const actors=[
 {name:'gate2_r11_business_a',password:'gate2_r11_disposable_a',business:a,branch:'b6000000-0000-4000-8000-000000000001',qr:'e6000000-0000-4000-8000-000000000001',feedback:'f6000000-0000-4000-8000-000000000001',survey:'d6000000-0000-4000-8000-000000000001',loyalty:'96000000-0000-4000-8000-000000000001'},
 {name:'gate2_r11_business_b',password:'gate2_r11_disposable_b',business:b,branch:'b6000000-0000-4000-8000-000000000002',qr:'e6000000-0000-4000-8000-000000000002',feedback:'f6000000-0000-4000-8000-000000000002',survey:'d6000000-0000-4000-8000-000000000002',loyalty:'96000000-0000-4000-8000-000000000002'},
];
const noTenant={name:'gate2_r11_unmapped',password:'gate2_r11_disposable_unmapped'};
const principals=[...actors,noTenant];
const tables=[
 {name:'businesses',selector:'id'},
 {name:'branches',selector:'business_id'},
 {name:'feedback',selector:'business_id'},
 {name:'surveys',selector:'business_id'},
 {name:'loyalty_accounts',selector:'business_id'},
];
const check=(ok,code)=>{if(!ok)throw Error('GATE2_R11_'+code);};
const owner=new pg.Client({connectionString:DB_URL});
try {
 await owner.connect();
 const info=(await owner.query(
  "SELECT current_database() db,current_user username,current_setting('server_version_num')::int version"
 )).rows[0];
 check(info.db==='echogrid_ci_pg18_principal'&&info.username==='echogrid'&&Math.floor(info.version/10000)===18,'DATABASE_IDENTITY');
 check((await owner.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n===67,'MIGRATION_COUNT');

 for(const {name} of tables){
  const flags=(await owner.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',['public.'+name])).rows[0];
  check(flags&&!flags.relrowsecurity&&!flags.relforcerowsecurity,'BASELINE_SCHEMA_'+name);
 }
 await owner.query('BEGIN');
 try {
  for(const [i,actor] of actors.entries()){
    await owner.query('INSERT INTO public.businesses(id,name,slug) VALUES($1,$2,$3)',[actor.business,'Gate 2 R11 synthetic business', 'gate2-r11-'+i]);
    await owner.query('INSERT INTO public.branches(id,business_id,name,slug) VALUES($1,$2,$3,$4)',[actor.branch,actor.business,'Synthetic R11 branch','r11-branch']);
    await owner.query('INSERT INTO public.qr_codes(id,business_id,branch_id) VALUES($1,$2,$3)',[actor.qr,actor.business,actor.branch]);
    await owner.query('INSERT INTO public.feedback(id,business_id,branch_id,qr_code_id,rating,comment) VALUES($1,$2,$3,$4,5,$5)',[actor.feedback,actor.business,actor.branch,actor.name+' private']);
    await owner.query("INSERT INTO public.surveys(id,owner_type,business_id,name) VALUES($1,'business',$2,$3)",[actor.survey,actor.business,'R11 synthetic survey']);
  }
  await owner.query('INSERT INTO public.customers(id,phone) VALUES($1,$2)',[customer,'+15550009111']);
  for(const actor of actors) {
   await owner.query('INSERT INTO public.loyalty_accounts(id,customer_id,business_id) VALUES($1,$2,$3)',[actor.loyalty,customer,actor.business]);
  }
  await owner.query('COMMIT');
 }catch(e){await owner.query('ROLLBACK');throw e;}

 // Only owner can modify the mapping; no client may supply an arbitrary
 // tenant UUID as the trusted identity. session_user tracks actual login.
 await owner.query('CREATE SCHEMA gate2_r11');
 await owner.query(`CREATE TABLE gate2_r11.login_tenants(
   login_name name PRIMARY KEY,
   business_id uuid NOT NULL REFERENCES public.businesses(id)
 )`);
 await owner.query('REVOKE ALL ON SCHEMA gate2_r11 FROM PUBLIC');
 await owner.query('REVOKE ALL ON TABLE gate2_r11.login_tenants FROM PUBLIC');
 for(const principal of principals) {
   await owner.query(`CREATE ROLE "${principal.name}" LOGIN INHERIT NOSUPERUSER
     NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${principal.password}'`);
 }
 for(const actor of actors) {
   await owner.query('INSERT INTO gate2_r11.login_tenants(login_name,business_id) VALUES($1,$2)',[actor.name,actor.business]);
 }
 await owner.query(`
   CREATE FUNCTION gate2_r11.trusted_business_id() RETURNS uuid
     LANGUAGE sql STABLE SECURITY DEFINER
     SET search_path=pg_catalog,gate2_r11 AS $fn$
       SELECT t.business_id FROM gate2_r11.login_tenants t
       WHERE t.login_name=session_user::name
     $fn$
 `);
 await owner.query('REVOKE ALL ON FUNCTION gate2_r11.trusted_business_id() FROM PUBLIC');
 for(const principal of principals){
   await owner.query(`GRANT USAGE ON SCHEMA gate2_r11 TO "${principal.name}"`);
   await owner.query(`GRANT EXECUTE ON FUNCTION gate2_r11.trusted_business_id() TO "${principal.name}"`);
   await owner.query(`GRANT USAGE ON SCHEMA public TO "${principal.name}"`);
 }
 for(const {name,selector} of tables) {
  await owner.query(`ALTER TABLE public."${name}" ENABLE ROW LEVEL SECURITY`);
  await owner.query(`ALTER TABLE public."${name}" FORCE ROW LEVEL SECURITY`);
  await owner.query(`CREATE POLICY gate2_r11_bound_select ON public."${name}"
     FOR SELECT TO "${actors[0].name}","${actors[1].name}","${noTenant.name}"
     USING ("${selector}"=gate2_r11.trusted_business_id())`);
  for(const principal of principals){
   await owner.query(`GRANT SELECT ON public."${name}" TO "${principal.name}"`);
  }
 }

 async function asPrincipal(p,run){
  const parsed=new URL(DB_URL);parsed.username=p.name;parsed.password=p.password;
  const db=new pg.Client({connectionString:parsed.toString()});
  try{await db.connect();return await run(db);}finally{await db.end().catch(()=>{});}
 }
 let counted=0;
 for(const actor of actors){
   await asPrincipal(actor,async db=>{
     const me=(await db.query(`SELECT session_user AS login,current_user AS role,
       gate2_r11.trusted_business_id()::text AS tenant`)).rows[0];
     check(me.login===actor.name&&me.role===actor.name&&me.tenant===actor.business,'PRINCIPAL_MAPPING_'+actor.name);
     const rights=(await db.query(`SELECT rolcanlogin,rolbypassrls,rolsuper,rolcreaterole,rolcreatedb
       FROM pg_roles WHERE rolname=current_user`)).rows[0];
     check(rights.rolcanlogin&&!rights.rolbypassrls&&!rights.rolsuper&&!rights.rolcreaterole&&!rights.rolcreatedb,'ROLE_PRIVILEGE_'+actor.name);
     const mappingRights=(await db.query(`SELECT
       has_table_privilege(current_user,'gate2_r11.login_tenants','SELECT') r,
       has_table_privilege(current_user,'gate2_r11.login_tenants','UPDATE') u,
       has_table_privilege(current_user,'gate2_r11.login_tenants','INSERT') i,
       has_schema_privilege(current_user,'gate2_r11','CREATE') c`)).rows[0];
     check(!mappingRights.r&&!mappingRights.u&&!mappingRights.i&&!mappingRights.c,'MAPPING_PRIVILEGE_'+actor.name);
     for(const {name} of tables){
      const rights=(await db.query(`SELECT
       row_security_active($1::regclass) AS rls,
       has_table_privilege(current_user,$1::regclass,'SELECT') AS can_read,
       has_table_privilege(current_user,$1::regclass,'INSERT') AS can_insert,
       has_table_privilege(current_user,$1::regclass,'UPDATE') AS can_update,
       has_table_privilege(current_user,$1::regclass,'DELETE') AS can_delete`,['public.'+name])).rows[0];
      check(rights.rls&&rights.can_read&&!rights.can_insert&&!rights.can_update&&!rights.can_delete,'TABLE_RIGHTS_'+name);
      const visible=(await db.query(`SELECT count(*)::int n FROM public."${name}"`)).rows[0].n;
      check(visible===1,'TENANT_SCOPE_'+name+'_'+actor.name);
      counted++;
     }

     // A custom GUC can be forged but cannot affect session_user or any
     // authorized view; unlike R10, the attacker learns no foreign rows.
     const other=actor.business===a?b:a;
     await db.query('BEGIN');
     try{
      await db.query("SELECT set_config('echogrid.tenant_id',$1,true)",[other]);
      check((await db.query(`SELECT gate2_r11.trusted_business_id()::text tenant`)).rows[0].tenant===actor.business,'GUC_SPOOFED_BOUND_ID');
      for(const {name,selector} of tables) {
       const foreign=(await db.query(`SELECT count(*)::int n FROM public."${name}" WHERE "${selector}"=$1`,[other])).rows[0].n;
       check(foreign===0,'GUC_SPOOFED_FOREIGN_READ_'+name);
      }
     }finally{await db.query('ROLLBACK');}
     const post=(await db.query('SELECT gate2_r11.trusted_business_id()::text tenant')).rows[0];
     check(post.tenant===actor.business,'TRANSACTION_RESET');
     const otherLogin=actor.name===actors[0].name?actors[1].name:actors[0].name;
     let setRoleDenied=false;
     try{await db.query(`SET ROLE "${otherLogin}"`);}catch(e){setRoleDenied=e.code==='42501';}
     check(setRoleDenied,'CROSS_PRINCIPAL_SET_ROLE_ALLOWED');
     let setAuthDenied=false;
     try{await db.query(`SET SESSION AUTHORIZATION "${otherLogin}"`);}catch(e){setAuthDenied=e.code==='42501';}
     check(setAuthDenied,'CROSS_PRINCIPAL_SESSION_AUTH_ALLOWED');
   });
 }
 await asPrincipal(noTenant,async db=>{
   check((await db.query('SELECT gate2_r11.trusted_business_id() AS tenant')).rows[0].tenant===null,'UNMAPPED_HAS_TENANT');
   for(const {name} of tables){
    check((await db.query(`SELECT count(*)::int n FROM public."${name}"`)).rows[0].n===0,'UNMAPPED_ROW_LEAK_'+name);
   }
 });

 console.log(JSON.stringify({
  gate:'GATE2_R11_PG18_PRINCIPAL_TENANT_BINDING',test:'session_user_owner_mapping',
  policyExercise:'PASS',crossTenantSpoofReadDenied:true,
  mappedLogins:2,unmappedDenied:true,tablesChecked:tables.length,
  tenantReadsChecked:counted,customGucSpoofResisted:true,
  setRoleImpersonationDenied:true,sessionAuthorizationImpersonationDenied:true,
  sessionLoginPerTenantRequired:true,
  hyperdriveCompatibility:'NOT_CERTIFIED',sharedRuntimeLoginSupported:false,
  runtimeRoleReady:false,stagingCertification:'BLOCKED',
  noLiveNeonWrites:true,financialAuthorization:'NOT_GRANTED',
 }));
} finally {await owner.end().catch(()=>{});}
