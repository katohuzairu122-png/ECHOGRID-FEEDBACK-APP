/**
 * Gate 2 B4-06: independent disposable PG18 Ed25519 feasibility boundary.
 * No PostgreSQL pgcrypto raw Ed25519 verifier is claimed. Fail closed.
 */
import assert from 'node:assert/strict';
import { webcrypto, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { TextEncoder } from 'node:util';
import pg from 'pg';

const target='postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_b406';
if(process.env.GITHUB_ACTIONS!=='true'||
   process.env.GATE2_B406_DISPOSABLE!=='ACK_DISPOSABLE_PG18'||
   process.env.DATABASE_URL!==target) throw Error('B406_DISPOSABLE_ONLY');
const owner=new pg.Client({connectionString:target,statement_timeout:15000});
async function expectDenied(client,sql,params=[]){
  let code;
  try{await client.query(sql,params);}catch(error){code=error.code;}
  assert.equal(code,'42501','must fail closed');
}
try{
  await owner.connect();
  const identity=(await owner.query("SELECT current_database() db,current_user usr,current_setting('server_version_num')::int v")).rows[0];
  assert.equal(identity.db,'echogrid_ci_pg18_b406');
  assert.equal(identity.usr,'echogrid');
  assert.equal(Math.floor(identity.v/10000),18);
  assert.equal((await owner.query('SELECT count(*)::int n FROM drizzle.__drizzle_migrations')).rows[0].n,71);
  assert.equal((await owner.query("SELECT count(*)::int n FROM pg_available_extensions WHERE name='pgcrypto'")).rows[0].n,1);
  await owner.query('CREATE SCHEMA gate2_b406');
  await owner.query('REVOKE ALL ON SCHEMA gate2_b406 FROM PUBLIC');
  await owner.query('CREATE TABLE gate2_b406.public_keys(kid text PRIMARY KEY,public_hex text NOT NULL,state text NOT NULL)');
  await owner.query('CREATE TABLE gate2_b406.used_nonces(nonce uuid PRIMARY KEY,actor uuid NOT NULL)');
  await owner.query('REVOKE ALL ON ALL TABLES IN SCHEMA gate2_b406 FROM PUBLIC');
  await owner.query([
    'CREATE FUNCTION gate2_b406.read_branch(assertion jsonb,claimed_verified boolean DEFAULT false)',
    'RETURNS TABLE(branch_id uuid) LANGUAGE plpgsql VOLATILE SECURITY DEFINER',
    'SET search_path=pg_catalog,gate2_b406 AS $fn$',
    'BEGIN',
    "RAISE EXCEPTION 'B406 Ed25519 verifier not certified' USING ERRCODE='42501';",
    'END $fn$'
  ].join('\n'));
  await owner.query('REVOKE ALL ON FUNCTION gate2_b406.read_branch(jsonb,boolean) FROM PUBLIC');
  await owner.query("CREATE ROLE gate2_b406_ci_login LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD 'b406_disposable_password'");
  await owner.query('GRANT USAGE ON SCHEMA gate2_b406 TO gate2_b406_ci_login');
  await owner.query('GRANT EXECUTE ON FUNCTION gate2_b406.read_branch(jsonb,boolean) TO gate2_b406_ci_login');
  const pair=await webcrypto.subtle.generateKey('Ed25519',true,['sign','verify']);
  const claims={version:'B4-03/1',algorithm:'Ed25519',actorId:randomUUID(),sessionId:randomUUID(),businessId:randomUUID(),branchId:randomUUID(),operation:'branches:read',nonce:randomUUID()};
  const payload=new TextEncoder().encode(JSON.stringify(claims));
  const signature=new Uint8Array(await webcrypto.subtle.sign('Ed25519',pair.privateKey,payload));
  assert.equal(await webcrypto.subtle.verify('Ed25519',pair.publicKey,signature,payload),true);
  assert.equal(await webcrypto.subtle.verify('Ed25519',pair.publicKey,signature,new TextEncoder().encode(JSON.stringify({...claims,branchId:randomUUID()}))),false);
  await owner.query("INSERT INTO gate2_b406.public_keys VALUES($1,$2,'ACTIVE')",['test-only',Buffer.from(await webcrypto.subtle.exportKey('raw',pair.publicKey)).toString('hex')]);
  const restricted=new URL(target);restricted.username='gate2_b406_ci_login';restricted.password='b406_disposable_password';
  const user=new pg.Client({connectionString:restricted.toString(),statement_timeout:15000});
  try{
    await user.connect();
    const flags=(await user.query("SELECT rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.ok(Object.values(flags).every(v=>v===false),'login nonowner and no bypass');
    const priv=(await user.query("SELECT has_table_privilege(current_user,'gate2_b406.public_keys','SELECT') keyread,has_table_privilege(current_user,'gate2_b406.used_nonces','INSERT') noncewrite,has_table_privilege(current_user,'public.branches','SELECT') branchread")).rows[0];
    assert.ok(Object.values(priv).every(v=>v===false),'no direct tenant/key/nonce access');
    const envelope=JSON.stringify({claims,signature:Buffer.from(signature).toString('hex')});
    for(const claimed of [true,false,null]){
      await expectDenied(user,'SELECT * FROM gate2_b406.read_branch($1::jsonb,$2::boolean)',[envelope,claimed]);
    }
    await expectDenied(user,'SELECT * FROM gate2_b406.read_branch($1::jsonb,$2::boolean)',[JSON.stringify({claims:{...claims,businessId:randomUUID()}}),true]);
    await expectDenied(user,'SELECT * FROM gate2_b406.public_keys');
    await expectDenied(user,'SELECT * FROM gate2_b406.used_nonces');
    await expectDenied(user,'SELECT * FROM public.branches');
    assert.equal((await owner.query('SELECT count(*)::int n FROM gate2_b406.used_nonces')).rows[0].n,0);
    assert.equal((await owner.query("SELECT has_function_privilege('gate2_b406_ci_login','gate2_b406.read_branch(jsonb,boolean)','EXECUTE') x")).rows[0].x,true);
    console.log(JSON.stringify({gate:'GATE2_B406_ED25519_PG18',result:'PASS_FAIL_CLOSED_ONLY',roleNonowner:true,postgresMajor:18,
      validExternalSignatureDenied:true,claimedVerifiedIgnored:true,noncesConsumed:0,
      rawEd25519SqlVerifierCertified:false,liveAccess:false,needsOwnerVerifierDecision:true}));
  }finally{await user.end().catch(()=>{});}
}finally{await owner.end().catch(()=>{});}
