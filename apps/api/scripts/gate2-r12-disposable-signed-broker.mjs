/**
 * Gate 2 R12: signed, single-purpose, replay-rejecting DB access broker.
 * Pure feasibility exercise against a disposable GitHub Actions PostgreSQL 18
 * database. This is NOT production authentication or an approved migration.
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

const DB_URL = 'postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_broker';
if (process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GATE2_R12_DISPOSABLE !== 'I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    process.env.DATABASE_URL !== DB_URL) throw Error('GATE2_R12_NON_DISPOSABLE_TARGET_DENIED');

const tenantA='a7000000-0000-4000-8000-000000000001';
const tenantB='a7000000-0000-4000-8000-000000000002';
const actorA='c7000000-0000-4000-8000-000000000001';
const actorB='c7000000-0000-4000-8000-000000000002';
const login='gate2_r12_disposable_broker';
const password='gate2_r12_ci_only';
const secret=randomBytes(32);
const fail=(condition,code)=>{if(!condition)throw Error('GATE2_R12_'+code);};
const signedMessage=(actor,business,action,nonce,expires)=>['v1',actor,business,action,nonce,String(expires)].join('|');
const signer=(actor,business,action='branches:list',nonce=randomUUID(),expires=Math.floor(Date.now()/1000)+60)=>({
 actor,business,action,nonce,expires,
 signature:createHmac('sha256',secret).update(signedMessage(actor,business,action,nonce,expires)).digest('hex'),
});
const owner=new pg.Client({connectionString:DB_URL});
try {
 await owner.connect();
 const info=(await owner.query(
  "SELECT current_database() db,current_user username,current_setting('server_version_num')::int version"
 )).rows[0];
 fail(info.db==='echogrid_ci_pg18_broker'&&info.username==='echogrid'&&
  Math.floor(info.version/10000)===18,'WRONG_DATABASE');
 fail((await owner.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n===72,'JOURNAL_NOT_REPLAYED');

 for(const [id,suffix] of [[tenantA,'a'],[tenantB,'b']]){
  await owner.query('INSERT INTO public.businesses(id,name,slug) VALUES($1,$2,$3)',
   [id,'R12 synthetic '+suffix,'gate2-r12-'+suffix]);
  await owner.query('INSERT INTO public.branches(business_id,name,slug) VALUES($1,$2,$3)',
   [id,'R12 private '+suffix,'gate2-r12-branch']);
 }
 await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
 await owner.query('CREATE SCHEMA gate2_r12');
 await owner.query('REVOKE ALL ON SCHEMA gate2_r12 FROM PUBLIC');
 await owner.query(`
  CREATE TABLE gate2_r12.verification_keys(id integer PRIMARY KEY, secret bytea NOT NULL)
 `);
 await owner.query('INSERT INTO gate2_r12.verification_keys(id,secret) VALUES(1,$1)',[secret]);
 await owner.query(`
  CREATE TABLE gate2_r12.actor_memberships(
    actor uuid NOT NULL, business uuid NOT NULL,
    PRIMARY KEY(actor,business)
  )
 `);
 await owner.query('INSERT INTO gate2_r12.actor_memberships(actor,business) VALUES($1,$2),($3,$4)',
  [actorA,tenantA,actorB,tenantB]);
 await owner.query(`
  CREATE TABLE gate2_r12.used_nonces(nonce uuid PRIMARY KEY, expires bigint NOT NULL)
 `);
 await owner.query('REVOKE ALL ON ALL TABLES IN SCHEMA gate2_r12 FROM PUBLIC');
 await owner.query(`
 CREATE FUNCTION gate2_r12.list_branches(
  p_actor uuid,p_business uuid,p_action text,p_nonce uuid,p_expires bigint,p_signature text
 ) RETURNS TABLE(branch_id uuid,branch_name text)
 LANGUAGE plpgsql VOLATILE SECURITY DEFINER
 SET search_path=pg_catalog,gate2_r12
 AS $fn$
 DECLARE
  v_secret bytea;
  v_expected text;
  v_now bigint;
 BEGIN
  -- Bound the input and reject unexpected operations, even if signed.
  IF p_action IS DISTINCT FROM 'branches:list' OR
     p_signature !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'R12 authorization denied' USING ERRCODE='42501';
  END IF;
  v_now:=floor(extract(epoch from clock_timestamp()))::bigint;
  IF p_expires < v_now OR p_expires > v_now + 120 THEN
    RAISE EXCEPTION 'R12 expired or overlong assertion' USING ERRCODE='42501';
  END IF;
  SELECT k.secret INTO v_secret FROM gate2_r12.verification_keys k WHERE k.id=1;
  IF v_secret IS NULL THEN
    RAISE EXCEPTION 'R12 missing verification key' USING ERRCODE='42501';
  END IF;
  v_expected:=encode(public.hmac(convert_to(
   'v1|'||p_actor::text||'|'||p_business::text||'|'||p_action||'|'||
   p_nonce::text||'|'||p_expires::text,'UTF8'),v_secret,'sha256'),'hex');
  IF v_expected IS DISTINCT FROM p_signature THEN
    RAISE EXCEPTION 'R12 invalid assertion' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS(
   SELECT 1 FROM gate2_r12.actor_memberships m
    WHERE m.actor=p_actor AND m.business=p_business
  ) THEN
    RAISE EXCEPTION 'R12 nonmember' USING ERRCODE='42501';
  END IF;
  INSERT INTO gate2_r12.used_nonces(nonce,expires)
    VALUES(p_nonce,p_expires) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R12 replay rejected' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT b.id,b.name FROM public.branches b
    WHERE b.business_id=p_business ORDER BY b.id;
 END
 $fn$
 `);
 await owner.query('REVOKE ALL ON FUNCTION gate2_r12.list_branches(uuid,uuid,text,uuid,bigint,text) FROM PUBLIC');
 await owner.query(`CREATE ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
 await owner.query(`GRANT USAGE ON SCHEMA gate2_r12 TO ${login}`);
 await owner.query(`GRANT EXECUTE ON FUNCTION gate2_r12.list_branches(uuid,uuid,text,uuid,bigint,text) TO ${login}`);

 const url=new URL(DB_URL);url.username=login;url.password=password;
 const db=new pg.Client({connectionString:url.toString()});
 try {
  await db.connect();
  const flags=(await db.query(`
   SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user
  `)).rows[0];
  fail(!flags.rolsuper&&!flags.rolbypassrls&&!flags.rolcreaterole&&!flags.rolcreatedb,'ROLE_NOT_RESTRICTED');
  const direct=(await db.query(`
   SELECT has_table_privilege(current_user,'public.branches','SELECT') AS select_grant,
    has_table_privilege(current_user,'public.branches','INSERT') AS insert_grant,
    has_schema_privilege(current_user,'public','CREATE') AS create_grant,
    has_table_privilege(current_user,'gate2_r12.verification_keys','SELECT') AS secret_grant,
    has_table_privilege(current_user,'gate2_r12.actor_memberships','UPDATE') AS member_grant
  `)).rows[0];
  fail(!Object.values(direct).some(Boolean),'DIRECT_PRIVILEGE_LEAK');
  const call=(token)=>db.query(
   'SELECT * FROM gate2_r12.list_branches($1,$2,$3,$4,$5,$6)',
   [token.actor,token.business,token.action,token.nonce,token.expires,token.signature],
  );
  const denied=async (token,code)=>{
   let rejected=false;
   try{await call(token);}catch(e){rejected=e.code==='42501';}
   fail(rejected,code);
  };
  const first=signer(actorA,tenantA);
  const result=await call(first);
  fail(result.rows.length===1&&result.rows[0].branch_name==='R12 private a','OWN_TENANT_READ');
  await denied(first,'REPLAY_ACCEPTED');
  const second=signer(actorB,tenantB);
  const ownB=await call(second);
  fail(ownB.rows.length===1&&ownB.rows[0].branch_name==='R12 private b','SECOND_TENANT_READ');
  // A valid proof for A cannot be relabeled for B.
  await denied({...signer(actorA,tenantA),business:tenantB},'BUSINESS_TAMPER_ACCEPTED');
  await denied({...signer(actorA,tenantA),actor:actorB},'ACTOR_TAMPER_ACCEPTED');
  await denied({...signer(actorA,tenantA),action:'branches:delete'},'OPERATION_TAMPER_ACCEPTED');
  await denied(signer(actorA,tenantA,'branches:list',randomUUID(),Math.floor(Date.now()/1000)-10),'EXPIRED_ACCEPTED');
  await denied(signer(actorA,tenantA,'branches:list',randomUUID(),Math.floor(Date.now()/1000)+300),'LONG_LIVED_ACCEPTED');
  // Validly signed assertion for a nonexistent membership cannot authorize.
  await denied(signer(actorA,tenantB),'NONMEMBER_ACCEPTED');
  await db.query("SELECT set_config('echogrid.tenant_id',$1,false)",[tenantB]);
  const gucProof=signer(actorA,tenantA);
  const gucResult=await call(gucProof);
  fail(gucResult.rows.length===1&&gucResult.rows[0].branch_name==='R12 private a','GUC_OVERRIDDEN_AUTH');
  let sqlDenied=false;
  try{await db.query('SELECT * FROM public.branches');}catch(e){sqlDenied=e.code==='42501';}
  fail(sqlDenied,'ARBITRARY_SQL_READ_ALLOWED');
  let keyDenied=false;
  try{await db.query('SELECT * FROM gate2_r12.verification_keys');}catch(e){keyDenied=e.code==='42501';}
  fail(keyDenied,'SECRET_TABLE_EXPOSED');
  console.log(JSON.stringify({
   gate:'GATE2_R12_SIGNED_BROKER_POC',policyExercise:'PASS',
   ownerControlledKey:true,ownerControlledMembership:true,
   noDirectTableAccess:true,operationBound:true,tenantBound:true,
   signatureTamperDenied:true,replayDenied:true,expiryEnforced:true,
   clientGucIgnored:true,postgresMajor:18,committedMigrations:72,
   runtimeKeyDistribution:'NOT_DESIGNED',
   trustedIssuer:'SIMULATED_IN_DISPOSABLE_CI_ONLY',
   stagingCertification:'BLOCKED',runtimeRoleReady:false,
   providerEffects:false,financialAuthorization:'NOT_GRANTED',
  }));
 }finally{await db.end().catch(()=>{});}
}finally{await owner.end().catch(()=>{});}
