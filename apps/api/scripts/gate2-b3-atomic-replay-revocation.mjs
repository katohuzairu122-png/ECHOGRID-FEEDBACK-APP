/**
 * Gate 2 B3 — synthetic HMAC signed session/tenant/branch request verification.
 * Disposable GitHub Actions PG18 ONLY. Not a trusted external issuer or live broker.
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers';
import pg from 'pg';
import { URL as NodeURL } from 'node:url';
const URL='postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_b3_broker';
if(process.env.GITHUB_ACTIONS!=='true' ||
 process.env.GATE2_B3_DISPOSABLE!=='I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
 process.env.DATABASE_URL!==URL) throw Error('B3_DISPOSABLE_GUARD');
const actorA='b7000000-0000-4000-8000-000000000001';
const actorB='b7000000-0000-4000-8000-000000000002';
const tenantA='a7000000-0000-4000-8000-000000000001';
const tenantB='a7000000-0000-4000-8000-000000000002';
const branchA='c7000000-0000-4000-8000-000000000001';
const branchB='c7000000-0000-4000-8000-000000000002';
const sidA=randomUUID(),sidB=randomUUID();
const key=randomBytes(32); // generated in test runner; DB must hold verifier's HMAC key
const ISS='echogrid:b3:fixture-issuer',AUD='echogrid:b3:db-broker',KID='b3_fixture_key';
const LOGIN='gate2_b3_ci_login',PASSWORD='gate2_b3_disposable_password';
const canonical=c=>['b3-v1',c.kid,c.iss,c.aud,c.actor,c.sid,c.business,c.branch,c.action,c.nonce,c.request,String(c.iat),String(c.exp)].join('|');
const sign=(o={})=>{
 const now=Math.floor(Date.now()/1000);
 const claims={kid:KID,iss:ISS,aud:AUD,actor:actorA,sid:sidA,business:tenantA,branch:branchA,
  action:'branches:list',nonce:randomUUID(),request:randomUUID(),iat:now,exp:now+60,...o};
 return {...claims,sig:createHmac('sha256',key).update(canonical(claims)).digest('hex')};
};
const owner=new pg.Client({connectionString:URL,statement_timeout:15000});
const deny=async(c,t,label)=>{
 let rejected=false;
 try{await call(c,t);}catch(e){rejected=e.code==='42501';}
 assert.ok(rejected,label);
};
const call=(c,t)=>c.query(
 'SELECT * FROM gate2_b3.list_one_branch($1::text,$2::text,$3::text,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8::text,$9::uuid,$10::uuid,$11::bigint,$12::bigint,$13::text)',
 [t.kid,t.iss,t.aud,t.actor,t.sid,t.business,t.branch,t.action,t.nonce,t.request,t.iat,t.exp,t.sig]);
try{
 await owner.connect();
 const identity=(await owner.query("SELECT current_database() db,current_user usr,current_setting('server_version_num')::int version")).rows[0];
 assert.equal(identity.db,'echogrid_ci_pg18_b3_broker');
 assert.equal(identity.usr,'echogrid');
 assert.equal(Math.floor(identity.version/10000),18);
 assert.equal((await owner.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,68);
 await owner.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
 await owner.query('CREATE SCHEMA gate2_b3');
 await owner.query('REVOKE ALL ON SCHEMA gate2_b3 FROM PUBLIC');
 await owner.query('CREATE TABLE gate2_b3.keys(kid text PRIMARY KEY, secret bytea NOT NULL, active boolean NOT NULL DEFAULT true)');
 await owner.query('CREATE TABLE gate2_b3.sessions(actor uuid NOT NULL,sid uuid NOT NULL,active boolean NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(actor,sid))');
 await owner.query('CREATE TABLE gate2_b3.memberships(actor uuid NOT NULL,business uuid NOT NULL,branch uuid NOT NULL,active boolean NOT NULL,PRIMARY KEY(actor,business,branch))');
 await owner.query('CREATE TABLE gate2_b3.branches(business uuid NOT NULL,branch uuid PRIMARY KEY,name text NOT NULL)');
 await owner.query('CREATE TABLE gate2_b3.used_nonces(nonce uuid PRIMARY KEY,request uuid NOT NULL,actor uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp())');
 await owner.query('REVOKE ALL ON ALL TABLES IN SCHEMA gate2_b3 FROM PUBLIC');
 await owner.query('INSERT INTO gate2_b3.keys(kid,secret) VALUES($1,$2)',[KID,key]);
 await owner.query("INSERT INTO gate2_b3.sessions VALUES ($1,$2,true,clock_timestamp()+interval '1 hour'),($3,$4,true,clock_timestamp()+interval '1 hour')",[actorA,sidA,actorB,sidB]);
 await owner.query('INSERT INTO gate2_b3.memberships VALUES ($1,$2,$3,true),($4,$5,$6,true)',[actorA,tenantA,branchA,actorB,tenantB,branchB]);
 await owner.query("INSERT INTO gate2_b3.branches VALUES ($1,$2,'A'),($3,$4,'B')",[tenantA,branchA,tenantB,branchB]);
 const sql=[
 'CREATE FUNCTION gate2_b3.list_one_branch(',
 'p_kid text,p_iss text,p_aud text,p_actor uuid,p_sid uuid,p_business uuid,p_branch uuid,',
 'p_action text,p_nonce uuid,p_request uuid,p_iat bigint,p_exp bigint,p_sig text)',
 'RETURNS TABLE(branch_id uuid,branch_name text) LANGUAGE plpgsql VOLATILE SECURITY DEFINER',
 'SET search_path=pg_catalog,gate2_b3 AS $fn$',
 'DECLARE k bytea; expected text; now_seconds bigint;',
 'BEGIN',
 'now_seconds:=floor(extract(epoch from clock_timestamp()))::bigint;',
 "IF p_kid IS DISTINCT FROM 'b3_fixture_key' OR p_iss IS DISTINCT FROM 'echogrid:b3:fixture-issuer' OR",
 "p_aud IS DISTINCT FROM 'echogrid:b3:db-broker' OR p_action IS DISTINCT FROM 'branches:list' OR",
 "p_actor IS NULL OR p_sid IS NULL OR p_business IS NULL OR p_branch IS NULL OR p_nonce IS NULL OR p_request IS NULL OR",
 "p_iat IS NULL OR p_exp IS NULL OR p_exp <= now_seconds OR p_iat > now_seconds+5 OR",
 "p_exp <= p_iat OR p_exp-p_iat>120 OR p_sig IS NULL OR p_sig !~ '^[0-9a-f]{64}$' THEN",
 "RAISE EXCEPTION 'B3 denied' USING ERRCODE='42501'; END IF;",
 'SELECT secret INTO k FROM gate2_b3.keys WHERE kid=p_kid AND active=true;',
 "IF k IS NULL THEN RAISE EXCEPTION 'B3 unavailable verifier' USING ERRCODE='42501'; END IF;",
 'expected:=encode(public.hmac(convert_to(',
 "'b3-v1|'||p_kid||'|'||p_iss||'|'||p_aud||'|'||p_actor::text||'|'||p_sid::text||'|'||",
 "p_business::text||'|'||p_branch::text||'|'||p_action||'|'||p_nonce::text||'|'||",
 "p_request::text||'|'||p_iat::text||'|'||p_exp::text,'UTF8'),k,'sha256'),'hex');",
 "IF expected IS DISTINCT FROM p_sig THEN RAISE EXCEPTION 'B3 invalid signature' USING ERRCODE='42501'; END IF;",
 'PERFORM 1 FROM gate2_b3.sessions WHERE actor=p_actor AND sid=p_sid AND active=true AND expires_at>clock_timestamp() FOR UPDATE;',
 "IF NOT FOUND THEN RAISE EXCEPTION 'B3 revoked session' USING ERRCODE='42501'; END IF;",
 'PERFORM 1 FROM gate2_b3.memberships WHERE actor=p_actor AND business=p_business AND branch=p_branch AND active=true FOR UPDATE;',
 "IF NOT FOUND THEN RAISE EXCEPTION 'B3 forbidden membership' USING ERRCODE='42501'; END IF;",
 'INSERT INTO gate2_b3.used_nonces(nonce,request,actor) VALUES(p_nonce,p_request,p_actor) ON CONFLICT DO NOTHING;',
 "IF NOT FOUND THEN RAISE EXCEPTION 'B3 replay' USING ERRCODE='42501'; END IF;",
 'RETURN QUERY SELECT b.branch,b.name FROM gate2_b3.branches b WHERE b.business=p_business AND b.branch=p_branch;',
 'END $fn$'
 ].join('\n');
 await owner.query(sql);
 await owner.query('REVOKE ALL ON FUNCTION gate2_b3.list_one_branch(text,text,text,uuid,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text) FROM PUBLIC');
 await owner.query("CREATE ROLE gate2_b3_ci_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'gate2_b3_disposable_password'");
 await owner.query('GRANT USAGE ON SCHEMA gate2_b3 TO gate2_b3_ci_login');
 await owner.query('GRANT EXECUTE ON FUNCTION gate2_b3.list_one_branch(text,text,text,uuid,uuid,uuid,uuid,text,uuid,uuid,bigint,bigint,text) TO gate2_b3_ci_login');
 const url=new NodeURL(URL);url.username=LOGIN;url.password=PASSWORD;
 const db=new pg.Client({connectionString:url.toString(),statement_timeout:15000});
 try{
  await db.connect();
  const flags=(await db.query('SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.ok(!Object.values(flags).some(Boolean),'B3 restricted role');
  const permissions=(await db.query([
   "SELECT has_table_privilege(current_user,'gate2_b3.keys','SELECT') keyread,",
   "has_table_privilege(current_user,'gate2_b3.sessions','UPDATE') sessionedit,",
   "has_table_privilege(current_user,'public.branches','SELECT') directread"
  ].join(' '))).rows[0];
  assert.ok(!Object.values(permissions).some(Boolean),'B3 no direct access');
  const legit=sign();
  assert.deepEqual((await call(db,legit)).rows.map(x=>x.branch_name),['A']);
  await deny(db,legit,'reject same nonce replay');
  const validB=sign({actor:actorB,sid:sidB,business:tenantB,branch:branchB});
  assert.deepEqual((await call(db,validB)).rows.map(x=>x.branch_name),['B']);
  for(const [field,altered] of [
   ['actor',actorB],['sid',sidB],['business',tenantB],['branch',branchB],
   ['action','settlement:write'],['aud','other'],['iss','forged'],
   ['nonce',randomUUID()],['request',randomUUID()],['kid','unknown']
  ]) await deny(db,{...sign(),[field]:altered},'tamper '+field);
  await deny(db,sign({actor:actorA,sid:sidA,business:tenantB,branch:branchB}),'valid signature but not member');
  await deny(db,sign({exp:Math.floor(Date.now()/1000)-1,iat:Math.floor(Date.now()/1000)-80}),'expired');
  await deny(db,sign({exp:Math.floor(Date.now()/1000)+250}),'overlong TTL');
  await db.query("SELECT set_config('echogrid.tenant_id',$1,false)",[tenantB]);
  assert.deepEqual((await call(db,sign())).rows.map(x=>x.branch_name),['A'],'GUC cannot override signed tenant');

  // Same nonce in two independently authenticated restricted SQL connections:
  // one transaction wins, the other must reject the committed replay.
  const peer=new pg.Client({connectionString:url.toString(),statement_timeout:15000});
  const revoker=new pg.Client({connectionString:URL,statement_timeout:15000});
  await peer.connect();
  await revoker.connect();
  try{
   const nonceRace=sign();
   const pair=await Promise.allSettled([call(db,nonceRace),call(peer,nonceRace)]);
   assert.equal(pair.filter(x=>x.status==='fulfilled').length,1,'exactly one nonce winner');
   assert.equal(pair.filter(x=>x.status==='rejected'&&x.reason.code==='42501').length,1,'replay loser denied');

   // A business function's write and the nonce are in the same transaction.
   // Rolling back the caller transaction releases the nonce for a later retry.
   const afterRollback=sign();
   await db.query('BEGIN');
   await call(db,afterRollback);
   await db.query('ROLLBACK');
   assert.deepEqual((await call(db,afterRollback)).rows.map(x=>x.branch_name),['A']);
   await deny(db,afterRollback,'committed nonce rejects replay');

   // Revocation first holds the exact persisted session row. An in-flight
   // authorization blocks; after revocation commits it must fail closed.
   await revoker.query('BEGIN');
   await revoker.query('UPDATE gate2_b3.sessions SET active=false WHERE actor=$1 AND sid=$2',[actorB,sidB]);
   const blocked=call(peer,sign({actor:actorB,sid:sidB,business:tenantB,branch:branchB}))
     .then(()=>({accepted:true}),e=>({accepted:false,code:e.code}));
   await new Promise(resolve=>setTimeout(resolve,75));
   await revoker.query('COMMIT');
   assert.deepEqual(await blocked,{accepted:false,code:'42501'},'revocation-first must deny');
   // Restore this synthetic fixture so later key-disable check is independent
   // of the already tested session revocation.
   await owner.query('UPDATE gate2_b3.sessions SET active=true WHERE actor=$1 AND sid=$2',[actorB,sidB]);

   // Issuance first: nonce and fixed operation commit before revocation.
   // Revocation must wait on the session lock; future use is denied.
   await db.query('BEGIN');
   const beforeRevoke=sign();
   assert.deepEqual((await call(db,beforeRevoke)).rows.map(x=>x.branch_name),['A']);
   const pendingRevocation=revoker.query(
     'UPDATE gate2_b3.sessions SET active=false WHERE actor=$1 AND sid=$2',[actorA,sidA]);
   await new Promise(resolve=>setTimeout(resolve,75));
   await db.query('COMMIT');
   assert.equal((await pendingRevocation).rowCount,1,'revocation must complete after issue');
   await deny(db,sign(),'post-revocation request');
   await owner.query('UPDATE gate2_b3.sessions SET active=true WHERE actor=$1 AND sid=$2',[actorA,sidA]);
  }finally{
   await peer.end().catch(()=>{});
   await revoker.end().catch(()=>{});
  }

  await owner.query('UPDATE gate2_b3.sessions SET active=false WHERE actor=$1 AND sid=$2',[actorA,sidA]);
  await deny(db,sign(),'revoked session');
  await owner.query('UPDATE gate2_b3.keys SET active=false WHERE kid=$1',[KID]);
  await deny(db,sign({actor:actorB,sid:sidB,business:tenantB,branch:branchB}),'key revocation');
  let forbidden=false;
  try{await db.query('SELECT * FROM gate2_b3.keys');}catch(e){forbidden=e.code==='42501';}
  assert.ok(forbidden,'private verifier secret not readable');
  console.log(JSON.stringify({gate:'GATE2_B3_DISPOSABLE_SIGNED_BROKER',result:'PASS',realPostgres:true,
   signedActorSessionTenantBranchOperationRequest:true,keyRevocation:true,replayDenied:true,
   sameNonceConcurrency:true,revocationFirstSerialized:true,issuanceFirstSerialized:true,rollbackNonceReusable:true,
   roleDeniedDirectTables:true,issuer:'TEST_FIXTURE_ONLY',stagingCertified:false}));
 }finally{await db.end().catch(()=>{});}
}finally{await owner.end().catch(()=>{});}
