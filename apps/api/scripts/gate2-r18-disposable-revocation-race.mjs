/**
 * Gate 2 R18 — disposable-only PostgreSQL authorization/revocation race proof.
 * CI-locked local database; creates only disposable synthetic schema objects.
 * Not an issuer, signing/verifier implementation, migration or live role.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const DATABASE_URL='postgresql://echogrid:echogrid@localhost:5432/echogrid_ci_pg18_revocation';
if (process.env.GITHUB_ACTIONS!=='true' ||
    process.env.GATE2_R18_DISPOSABLE!=='I_ACKNOWLEDGE_DISPOSABLE_PG18' ||
    process.env.DATABASE_URL!==DATABASE_URL)
  throw Error('R18_DISPOSABLE_DATABASE_GUARD');
const ACTOR_A='b8000000-0000-4000-8000-000000000001';
const ACTOR_B='b8000000-0000-4000-8000-000000000002';
const TENANT_A='a8000000-0000-4000-8000-000000000001';
const TENANT_B='a8000000-0000-4000-8000-000000000002';
const db=()=>new pg.Client({connectionString:DATABASE_URL});
const connected=async()=>{const c=db();await c.connect();await c.query("SET statement_timeout = '10s'");return c;};
const owner=await connected();
const close=async(c)=>c.end().catch(()=>{});
const uuid=randomUUID;
async function insertFixture(sid,actor=ACTOR_A){
  await owner.query('INSERT INTO gate2_r18.sessions(actor,sid,expires_at) VALUES($1,$2,clock_timestamp()+interval \'1 hour\')',[actor,sid]);
}
async function issue(client,{actor=ACTOR_A,sid,tenant=TENANT_A,operation='branches:list',hold}){
  await client.query('BEGIN');
  try{
    // A row lock must be acquired BEFORE deciding whether the session is live.
    // All compatible revocations also UPDATE the same session row.
    const session=(await client.query(
      'SELECT active,expires_at FROM gate2_r18.sessions WHERE actor=$1 AND sid=$2 FOR UPDATE',
      [actor,sid])).rows[0];
    if(!session?.active || new Date(session.expires_at).getTime()<=Date.now())
      throw Error('SESSION_DENIED');
    const business=(await client.query(
      'SELECT active FROM gate2_r18.businesses WHERE business=$1 FOR UPDATE',[tenant])).rows[0];
    if(!business?.active)throw Error('BUSINESS_DENIED');
    const member=(await client.query(
      'SELECT active FROM gate2_r18.memberships WHERE actor=$1 AND business=$2 AND operation=$3 FOR UPDATE',
      [actor,tenant,operation])).rows[0];
    if(!member?.active)throw Error('MEMBERSHIP_DENIED');
    if(hold)await hold();
    const nonce=uuid();
    await client.query(
      'INSERT INTO gate2_r18.authorizations(nonce,actor,sid,business,operation) VALUES($1,$2,$3,$4,$5)',
      [nonce,actor,sid,tenant,operation]);
    await client.query('COMMIT');
    return {ok:true,nonce};
  }catch(e){
    await client.query('ROLLBACK').catch(()=>{});
    return {ok:false,reason:e.message};
  }
}
async function revoke(client,sid,actor=ACTOR_A){
  await client.query('BEGIN');
  try{
    const result=await client.query(
      'UPDATE gate2_r18.sessions SET active=false WHERE actor=$1 AND sid=$2 AND active=true RETURNING sid',
      [actor,sid]);
    await client.query('COMMIT');
    return result.rowCount;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
}
async function checkProof(nonce){
  const r=(await owner.query('SELECT * FROM gate2_r18.authorizations WHERE nonce=$1',[nonce])).rows;
  return r.length;
}
try{
  const identity=(await owner.query(
    "SELECT current_database() db,current_user usr,current_setting('server_version_num')::int v"
  )).rows[0];
  assert.equal(identity.db,'echogrid_ci_pg18_revocation');
  assert.equal(identity.usr,'echogrid');
  assert.equal(Math.floor(identity.v/10000),18);
  await owner.query('CREATE SCHEMA gate2_r18');
  await owner.query('CREATE TABLE gate2_r18.sessions(actor uuid NOT NULL,sid uuid NOT NULL,active boolean NOT NULL DEFAULT true,expires_at timestamptz NOT NULL,PRIMARY KEY(actor,sid))');
  await owner.query('CREATE TABLE gate2_r18.businesses(business uuid PRIMARY KEY,active boolean NOT NULL DEFAULT true)');
  await owner.query('CREATE TABLE gate2_r18.memberships(actor uuid NOT NULL,business uuid NOT NULL,operation text NOT NULL,active boolean NOT NULL DEFAULT true,PRIMARY KEY(actor,business,operation))');
  await owner.query('CREATE TABLE gate2_r18.authorizations(nonce uuid PRIMARY KEY,actor uuid NOT NULL,sid uuid NOT NULL,business uuid NOT NULL,operation text NOT NULL,committed_at timestamptz NOT NULL DEFAULT clock_timestamp())');
  await owner.query('INSERT INTO gate2_r18.businesses(business) VALUES($1),($2)',[TENANT_A,TENANT_B]);
  await owner.query('INSERT INTO gate2_r18.memberships(actor,business,operation) VALUES($1,$2,$3),($4,$5,$6)',
    [ACTOR_A,TENANT_A,'branches:list',ACTOR_B,TENANT_B,'branches:list']);
  const a=await connected(),b=await connected();
  try{
    // Regular session: A can issue only for A. No client-supplied tenant authority.
    const sid1=uuid();await insertFixture(sid1);
    const own=await issue(a,{sid:sid1});
    assert.equal(own.ok,true,JSON.stringify(own));
    assert.equal(await checkProof(own.nonce),1,'committed authorization must be visible on independent connection');
    const foreign=await issue(a,{sid:sid1,tenant:TENANT_B});
    assert.equal(foreign.reason,'MEMBERSHIP_DENIED');
    const wrongActor=await issue(a,{actor:ACTOR_B,sid:sid1,tenant:TENANT_B});
    assert.equal(wrongActor.reason,'SESSION_DENIED');

    // Revocation first: issuer must wait on session row and deny once revoke commits.
    const sid2=uuid();await insertFixture(sid2);
    await b.query('BEGIN');
    await b.query('UPDATE gate2_r18.sessions SET active=false WHERE actor=$1 AND sid=$2',[ACTOR_A,sid2]);
    const blockedIssue=issue(a,{sid:sid2});
    await b.query('COMMIT');
    const afterRevoke=await blockedIssue;
    assert.equal(afterRevoke.reason,'SESSION_DENIED');
    assert.equal((await owner.query('SELECT count(*)::int n FROM gate2_r18.authorizations WHERE sid=$1',[sid2])).rows[0].n,0);

    // Issuance first: the authorization commits before revoke can acquire its row.
    // This is valid ordering, not retroactive invalidation of committed work.
    const sid3=uuid();await insertFixture(sid3);
    let signalHeld;
    const held=new Promise(resolve=>{signalHeld=resolve;});
    let release;
    const released=new Promise(resolve=>{release=resolve;});
    const inFlight=issue(a,{sid:sid3,hold:async()=>{signalHeld();await released;}});
    await held;
    const delayedRevoke=revoke(b,sid3);
    release();
    const beforeRevocation=await inFlight;
    assert.equal(beforeRevocation.ok,true,JSON.stringify(beforeRevocation));
    assert.equal(await delayedRevoke,1);
    assert.equal(await checkProof(beforeRevocation.nonce),1);
    const after=await issue(a,{sid:sid3});
    assert.equal(after.reason,'SESSION_DENIED');
    // Same actor, independent session remains valid.
    const sid4=uuid();await insertFixture(sid4);
    assert.equal((await issue(a,{sid:sid4})).ok,true);

    // Membership revocation committed before issuance denies.
    await owner.query("UPDATE gate2_r18.memberships SET active=false WHERE actor=$1 AND business=$2",
      [ACTOR_A,TENANT_A]);
    const membershipDenied=await issue(a,{sid:sid4});
    assert.equal(membershipDenied.reason,'MEMBERSHIP_DENIED');
    await owner.query('UPDATE gate2_r18.memberships SET active=true WHERE actor=$1 AND business=$2',
      [ACTOR_A,TENANT_A]);
    await owner.query('UPDATE gate2_r18.businesses SET active=false WHERE business=$1',[TENANT_A]);
    assert.equal((await issue(a,{sid:sid4})).reason,'BUSINESS_DENIED');

    // Persistence across separate connections; no in-memory nonce-set proof.
    const count=(await b.query('SELECT count(*)::int n FROM gate2_r18.authorizations')).rows[0].n;
    assert.equal(count,3);
    console.log(JSON.stringify({gate:'GATE2_R18_DURABLE_CONCURRENCY',proof:'PASS',
      durableCommittedRows:count,revocationFirstDenied:true,issuanceFirstSerialized:true,
      otherSessionUnaffected:true,tenantMembershipDenied:true,
      postgresMajor:18,syntheticOnly:true,
      sessionAndMembershipRole:'TEST_OWNER_ONLY',runtimeAuthorization:'NOT_IMPLEMENTED',
      issuerIntegration:'NOT_IMPLEMENTED',stagingCertification:'BLOCKED'}));
  }finally{await close(a);await close(b);}
}finally{await close(owner);}
