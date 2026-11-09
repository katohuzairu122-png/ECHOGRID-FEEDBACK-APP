import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomBytes, randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import { buildDb } from '../../src/db/client';
import { signAccessToken, signImpersonationToken } from '../../src/auth/jwt';
import { TrustedBrokerAssertionIssuer } from '../../src/auth/trusted-broker-issuer';
import { brokerHex, verifyBrokerAssertionSignature } from '../../src/auth/broker-assertion.contract';

// No skip path. This suite must run against migrated, disposable local PG18.
const target = new URL(process.env.DATABASE_URL ?? 'http://unconfigured');
if (!['localhost','127.0.0.1'].includes(target.hostname) || !/^echogrid_(test|ci_)/.test(target.pathname.slice(1))) throw Error('B403_DISPOSABLE_PG18_REQUIRED');
const clients: Client[] = [];
const connect = async () => { const c = new Client({ connectionString: target.toString(), statement_timeout: 10000 }); await c.connect(); clients.push(c); return c; };
let admin: Client;
const secret = randomBytes(32).toString('hex');
beforeAll(async () => { admin = await connect(); expect(Number((await admin.query("select current_setting('server_version_num')::int n")).rows[0].n)).toBeGreaterThanOrEqual(180000); });
afterAll(async () => { for (const c of clients) await c.end(); });
async function fixture() {
  const actor = randomUUID(), business = randomUUID(), branch = randomUUID(), session = randomUUID(), role = randomUUID();
  await admin.query("insert into users(id,email,password_hash,full_name,status) values($1,$2,'fixture','Synthetic actor','active')", [actor, `${actor}@example.invalid`]);
  await admin.query("insert into businesses(id,name,slug,status) values($1,'Synthetic business',$2,'active')", [business,`b-${business}`]);
  await admin.query("insert into branches(id,business_id,name,slug) values($1,$2,'Synthetic branch',$3)", [branch,business,`b-${branch}`]);
  await admin.query("insert into roles(id,business_id,name) values($1,$2,'Reader')", [role,business]);
  const p = (await admin.query("insert into permissions(key,description,category) values('branches:view','Fixture','branches') on conflict(key) do update set description=excluded.description returning id")).rows[0].id;
  await admin.query('insert into role_permissions(role_id,permission_id) values($1,$2)', [role,p]);
  await admin.query('insert into user_business_roles(user_id,business_id,branch_id,role_id) values($1,$2,$3,$4)', [actor,business,branch,role]);
  await admin.query("insert into refresh_tokens(user_id,session_id,token_hash,expires_at) values($1,$2,'fixture',clock_timestamp()+interval '1 hour')", [actor,session]);
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign','verify']) as CryptoKeyPair;
  const sec = Math.floor(Date.now()/1000);
  const key = { keyId: 'disposable', version: 1, publicKeyHex: brokerHex(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey) as ArrayBuffer)), state: 'ACTIVE' as 'ACTIVE'|'REVOKED', notBefore: sec-60, notAfter: sec+3600 };
  const signer = { keyId: key.keyId, sign: async (m: Uint8Array) => new Uint8Array(await crypto.subtle.sign('Ed25519',pair.privateKey,m)) };
  const dbClient = await connect();
  const issuer = new TrustedBrokerAssertionIssuer({ db: buildDb(dbClient), accessSecret: secret, keys: async () => key, signer });
  const request = { authorization: `Bearer ${await signAccessToken(actor,secret,session)}`, businessId: business, branchId: branch, operation: 'branches:read' as const };
  return { actor,business,branch,session,role,key,signer,dbClient,issuer,request };
}
async function waitBlocked(pid: number) {
  const until = Date.now()+5000;
  while (Date.now()<until) {
    if ((await admin.query('select cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n > 0) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error('Expected a real PostgreSQL lock wait');
}
describe('B4-03 real authentication and transactional issuer foundation', () => {
  it('issues for actual JWT/session/membership/permission with fresh nonce and request identities; grants no broker authority', async () => {
    const f = await fixture();
    const ledger = (await admin.query('select count(*)::int n from partner_credit_ledger')).rows;
    const a = await f.issuer.issue(f.request), b = await f.issuer.issue(f.request);
    expect((await admin.query('select count(*)::int n from partner_credit_ledger')).rows).toEqual(ledger);
    expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) throw Error('ISSUANCE_FAILED');
    expect(a.assertion.claims).toMatchObject({ actorId:f.actor,sessionId:f.session,businessId:f.business,branchId:f.branch,authorizationVersion:null });
    expect(a.brokerAuthorization).toBe('NOT_GRANTED'); expect(a.assertion.claims.nonce).not.toBe(b.assertion.claims.nonce);
    expect(a.assertion.claims.requestId).not.toBe(b.assertion.claims.requestId);
    expect(await verifyBrokerAssertionSignature(a.assertion,async()=>f.key,Math.floor(Date.now()/1000))).toBe(true);
  });
  it.each(['missing','expired','customer','unsupported','impersonated','substituted'] as const)('rejects %s token/session binding', async kind => {
    const f = await fixture(), t = Math.floor(Date.now()/1000);
    const jwt = kind === 'missing' ? await signAccessToken(f.actor,secret) : kind === 'impersonated' ? (await signImpersonationToken(f.actor,randomUUID(),secret)).token :
      await sign({ sub:f.actor,sid:kind==='substituted'?randomUUID():f.session,type:kind==='customer'?'customer_access':kind==='unsupported'?'service':'access',iat:t-100,exp:kind==='expired'?t-1:t+60 },secret,'HS256');
    expect(await f.issuer.issue({...f.request,authorization:`Bearer ${jwt}`})).toMatchObject({ok:false,reason:'AUTHENTICATION_DENIED'});
  });
  it.each(['revoked','expired','foreign','suspended','deleted','inactive_business','missing_membership','missing_permission','foreign_branch','revoked_key'] as const)('rejects persisted %s', async kind => {
    const f = await fixture();
    if(kind==='revoked') await admin.query('update refresh_tokens set revoked_at=now() where session_id=$1',[f.session]);
    if(kind==='expired') await admin.query("update refresh_tokens set expires_at=now()-interval '1 second' where session_id=$1",[f.session]);
    if(kind==='foreign') { const other=await fixture(); await admin.query('update refresh_tokens set user_id=$1 where session_id=$2',[other.actor,f.session]); }
    if(kind==='suspended') await admin.query("update users set status='suspended' where id=$1",[f.actor]);
    if(kind==='deleted') await admin.query('update users set is_deleted=true where id=$1',[f.actor]);
    if(kind==='inactive_business') await admin.query("update businesses set status='suspended' where id=$1",[f.business]);
    if(kind==='missing_membership') await admin.query('update user_business_roles set deleted_at=now() where user_id=$1',[f.actor]);
    if(kind==='missing_permission') await admin.query('delete from role_permissions where role_id=$1',[f.role]);
    if(kind==='foreign_branch') { const other=await fixture(); f.request.branchId=other.branch; }
    if(kind==='revoked_key') f.key.state='REVOKED';
    expect(await f.issuer.issue(f.request)).toMatchObject({ok:false,brokerAuthorization:'NOT_GRANTED'});
  });
  it('denies cross-tenant selection, extra actor assertions and unsupported operations',async()=>{
    const f=await fixture(), other=await fixture();
    expect((await f.issuer.issue({...f.request,businessId:other.business,branchId:other.branch})).ok).toBe(false);
    expect((await f.issuer.issue({...f.request,actorId:other.actor} as typeof f.request)).ok).toBe(false);
    expect((await f.issuer.issue({...f.request,operation:'branches:delete'} as unknown as typeof f.request)).ok).toBe(false);
  });
  it('fails closed with unavailable authorization storage',async()=>{const f=await fixture();await f.dbClient.end();expect(await f.issuer.issue(f.request)).toMatchObject({ok:false,reason:'ISSUER_UNAVAILABLE'});});
  it('revocation locking first prevents issuance after its commit',async()=>{
    const f=await fixture(), revoke=await connect();
    await revoke.query('begin'); await revoke.query('update refresh_tokens set revoked_at=now() where session_id=$1',[f.session]);
    const pid=Number((await f.dbClient.query('select pg_backend_pid() n')).rows[0].n);
    const pending=f.issuer.issue(f.request);
    await waitBlocked(pid); await revoke.query('commit'); expect(await pending).toMatchObject({ok:false,reason:'AUTHENTICATION_DENIED'});
  });
  it('issuer locking first serializes revocation; next issuance denies',async()=>{
    const f=await fixture(), revoke=await connect(); let entered!:()=>void, release!:()=>void;
    const reached=new Promise<void>(r=>{entered=r;}), barrier=new Promise<void>(r=>{release=r;});
    const issuer=new TrustedBrokerAssertionIssuer({db:buildDb(f.dbClient),accessSecret:secret,keys:async()=>f.key,
      signer:{keyId:f.key.keyId,sign:async m=>{entered();await barrier;return f.signer.sign(m);}}});
    const pending=issuer.issue(f.request); await reached;
    const pid=Number((await revoke.query('select pg_backend_pid() n')).rows[0].n);
    const revoking=revoke.query('update refresh_tokens set revoked_at=now() where session_id=$1',[f.session]);
    await waitBlocked(pid); release(); expect((await pending).ok).toBe(true); await revoking;
    expect((await f.issuer.issue(f.request)).ok).toBe(false);
  });
  it('permission revocation holding its row first denies issuance after the lock wait',async()=>{
    const f=await fixture(), revoke=await connect();
    const pid=Number((await f.dbClient.query('select pg_backend_pid() n')).rows[0].n);
    await revoke.query('begin'); await revoke.query('delete from role_permissions where role_id=$1',[f.role]);
    const pending=f.issuer.issue(f.request);
    await waitBlocked(pid); await revoke.query('commit');
    expect(await pending).toMatchObject({ok:false,reason:'AUTHORIZATION_DENIED'});
  });
  it('key revocation during signing prevents returning an assertion',async()=>{
    const f=await fixture();
    const issuer=new TrustedBrokerAssertionIssuer({db:buildDb(f.dbClient),accessSecret:secret,keys:async()=>f.key,
      signer:{keyId:f.key.keyId,sign:async m=>{const bytes=await f.signer.sign(m);f.key.state='REVOKED';return bytes;}}});
    expect(await issuer.issue(f.request)).toMatchObject({ok:false,reason:'ISSUER_UNAVAILABLE'});
  });

  it('a restricted runtime login cannot substitute for issuer storage authority or fall back to unrestricted reads',async()=>{
    const f=await fixture(), name=`b403_denied_${randomBytes(5).toString('hex')}`, password=randomBytes(24).toString('hex');
    await admin.query(`create role ${name} login noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication password '${password}'`);
    const url=new URL(target);url.username=name;url.password=password;
    const restricted=new Client({connectionString:url.toString()});await restricted.connect();
    try {
      const issuer=new TrustedBrokerAssertionIssuer({db:buildDb(restricted),accessSecret:secret,keys:async()=>f.key,signer:f.signer});
      expect(await issuer.issue(f.request)).toMatchObject({ok:false,reason:'ISSUER_UNAVAILABLE'});
      for(const statement of ['select * from users','select * from branches',"update users set status='active'",'delete from user_business_roles'])
        await expect(restricted.query(statement)).rejects.toMatchObject({code:'42501'});
    } finally {await restricted.end();await admin.query(`drop role ${name}`);}
  });

});
