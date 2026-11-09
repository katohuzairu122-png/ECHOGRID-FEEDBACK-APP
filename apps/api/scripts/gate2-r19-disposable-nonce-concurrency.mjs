import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
// R19: CI-only, synthetic transactional nonce proof; never run on Neon.
const URL='postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_nonce';
if(process.env.GITHUB_ACTIONS!=='true'||process.env.GATE2_R19_DISPOSABLE!=='I_ACKNOWLEDGE_DISPOSABLE_PG18'||process.env.DATABASE_URL!==URL)throw Error('R19_NON_DISPOSABLE_TARGET');
const actor='b8000000-0000-4000-8000-000000000001';
const tenant='a8000000-0000-4000-8000-000000000001';
const operation='branches:list';
const owner=new pg.Client({connectionString:URL});
const pool=new pg.Pool({connectionString:URL,max:12,connectionTimeoutMillis:10000});
const consume=(nonce,business=tenant,action=operation,expiry=new Date(Date.now()+60000))=>
  pool.query('SELECT gate2_r19.consume($1::uuid,$2::uuid,$3::uuid,$4::text,$5::timestamptz) AS allowed',
    [nonce,actor,business,action,expiry]).then(r=>r.rows[0].allowed);
try{
 await owner.connect();
 const identity=(await owner.query("SELECT current_database() db,current_user usr,current_setting('server_version_num')::int v")).rows[0];
 assert.equal(identity.db,'echogrid_ci_pg18_nonce');
 assert.equal(identity.usr,'echogrid');
 assert.equal(Math.floor(identity.v/10000),18);
 await owner.query('CREATE SCHEMA gate2_r19');
 await owner.query('CREATE TABLE gate2_r19.used_nonces(nonce uuid PRIMARY KEY, actor uuid NOT NULL, business uuid NOT NULL, operation text NOT NULL, expires_at timestamptz NOT NULL, consumed_at timestamptz NOT NULL DEFAULT clock_timestamp())');
 await owner.query([
 'CREATE FUNCTION gate2_r19.consume(p_nonce uuid,p_actor uuid,p_business uuid,p_operation text,p_expires timestamptz)',
 'RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,gate2_r19 AS $$',
 'DECLARE v_now timestamptz;',
 'BEGIN',
 'v_now:=clock_timestamp();',
 "IF p_nonce IS NULL OR p_actor IS NULL OR p_business IS NULL OR p_operation IS DISTINCT FROM 'branches:list'",
 "OR p_expires IS NULL OR p_expires<=v_now OR p_expires>v_now+interval '120 seconds' THEN RETURN false; END IF;",
 'INSERT INTO gate2_r19.used_nonces(nonce,actor,business,operation,expires_at)',
 'VALUES(p_nonce,p_actor,p_business,p_operation,p_expires) ON CONFLICT (nonce) DO NOTHING;',
 'RETURN FOUND;',
 'END $$',
 ].join('\n'));
 const nonce=randomUUID(), expiry=new Date(Date.now()+60000);
 const attempts=await Promise.all(Array.from({length:24},()=>consume(nonce,tenant,operation,expiry)));
 assert.equal(attempts.filter(Boolean).length,1,'exactly one winner across connections');
 assert.equal(attempts.filter(x=>!x).length,23);
 assert.equal(await consume(nonce),false);
 assert.equal(await consume(nonce,randomUUID()),false,'cannot replay against another tenant');
 assert.equal(await consume(randomUUID(),tenant,'settlement:write'),false);
 assert.equal(await consume(randomUUID(),tenant,operation,new Date(Date.now()-1000)),false);
 assert.equal(await consume(randomUUID(),tenant,operation,new Date(Date.now()+300000)),false);
 const client=await pool.connect();
 const rolled=randomUUID();
 try {
  await client.query('BEGIN');
  const initial=await client.query('SELECT gate2_r19.consume($1,$2,$3,$4,$5) allowed',
    [rolled,actor,tenant,operation,new Date(Date.now()+60000)]);
  assert.equal(initial.rows[0].allowed,true);
  await client.query('ROLLBACK');
 }finally{client.release();}
 assert.equal(await consume(rolled),true,'rollback cannot burn nonce');
 assert.equal(await consume(rolled),false,'committed nonce rejects replay');
 const count=(await owner.query('SELECT count(*)::int n FROM gate2_r19.used_nonces')).rows[0].n;
 assert.equal(count,2);
 console.log(JSON.stringify({gate:'R19',result:'PASS',concurrency:24,accepted:1,
  rejected:23,rollbackSafe:true,durableRows:count,staging:'BLOCKED',runtime:'NOT_IMPLEMENTED'}));
}finally{await pool.end().catch(()=>{});await owner.end().catch(()=>{});}
