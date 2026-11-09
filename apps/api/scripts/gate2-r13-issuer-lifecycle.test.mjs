/**
 * Gate 2 R13: pure, disposable signing and verifier-state contract.
 * This is an OFFLINE architecture proof, NOT a deployed issuer or DB verifier.
 * Test-only private keys never appear in API, client, GitHub config or Neon.
 */
import { describe, it } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';

const AUDIENCE='echogrid:db-broker:v1';
const MAX_TTL_SECONDS=120;
const ACTION='branches:list';
const A='a8000000-0000-4000-8000-000000000001';
const B='a8000000-0000-4000-8000-000000000002';
const ACTOR_A='b8000000-0000-4000-8000-000000000001';
const ACTOR_B='b8000000-0000-4000-8000-000000000002';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const allowedActions=new Set([ACTION]);

// Canonical signed payload: no JSON reserialization or unicode ambiguity.
// The verifier only accepts canonical ASCII fields and fixed order.
function canonical(c) {
  return [
    'eg-broker-v1',c.kid,c.aud,c.iss,c.sub,c.business,c.action,
    c.nonce,String(c.iat),String(c.exp),String(c.actorEpoch),
    String(c.businessEpoch),
  ].join('|');
}
function strictClaims(c) {
  return c&&Object.getPrototypeOf(c)===Object.prototype &&
    Object.keys(c).sort().join(',')===
      ['action','actorEpoch','aud','business','businessEpoch','exp','iat','iss','kid','nonce','sub'].sort().join(',') &&
    typeof c.kid==='string'&&/^[a-z0-9_-]{1,36}$/.test(c.kid) &&
    c.aud===AUDIENCE && c.iss==='echogrid:trusted-issuer' &&
    typeof c.sub==='string'&&UUID.test(c.sub) &&
    typeof c.business==='string'&&UUID.test(c.business) &&
    allowedActions.has(c.action) &&
    typeof c.nonce==='string'&&UUID.test(c.nonce) &&
    Number.isSafeInteger(c.iat)&&Number.isSafeInteger(c.exp)&&
    Number.isSafeInteger(c.actorEpoch)&&c.actorEpoch>=0&&
    Number.isSafeInteger(c.businessEpoch)&&c.businessEpoch>=0;
}

function makeHarness() {
  const keys=new Map();
  const actorEpochs=new Map([[ACTOR_A,0],[ACTOR_B,0]]);
  const businessEpochs=new Map([[A,0],[B,0]]);
  const memberships=new Set([`${ACTOR_A}:${A}`,`${ACTOR_B}:${B}`]);
  const consumed=new Set();
  const publicVerifierKeys=new Map();
  function addKey(kid,notBefore,notAfter) {
    assert.match(kid,/^[a-z0-9_-]{1,36}$/);
    assert.ok(!keys.has(kid));
    const {privateKey,publicKey}=generateKeyPairSync('ed25519');
    keys.set(kid,{privateKey,notBefore,notAfter});
    // Independent verifier receives only public key material.
    publicVerifierKeys.set(kid,{publicKey,notBefore,notAfter,revoked:false});
  }
  function revokeKey(kid) {
    const key=publicVerifierKeys.get(kid);if(key)key.revoked=true;
  }
  function removeMember(actor,business) {
    memberships.delete(`${actor}:${business}`);
    actorEpochs.set(actor,(actorEpochs.get(actor)??0)+1);
  }
  function revokeActor(actor) {
    actorEpochs.set(actor,(actorEpochs.get(actor)??0)+1);
  }
  function revokeBusiness(business) {
    businessEpochs.set(business,(businessEpochs.get(business)??0)+1);
  }
  // Trusted issuer simulates verified authn and effective membership.
  function issue({kid,actor,business,action=ACTION,now,ttl=60,nonce=randomUUID()}) {
    if(!memberships.has(`${actor}:${business}`))throw Error('ISSUER_MEMBERSHIP_DENIED');
    if(!allowedActions.has(action))throw Error('ISSUER_OPERATION_DENIED');
    if(!Number.isSafeInteger(now)||!Number.isSafeInteger(ttl)||ttl<=0||ttl>MAX_TTL_SECONDS)
      throw Error('ISSUER_TTL_DENIED');
    const key=keys.get(kid);
    if(!key||now<key.notBefore||now+ttl>key.notAfter)throw Error('ISSUER_KEY_UNAVAILABLE');
    const claims={
      kid,aud:AUDIENCE,iss:'echogrid:trusted-issuer',
      sub:actor,business,action,nonce,iat:now,exp:now+ttl,
      actorEpoch:actorEpochs.get(actor)??0,
      businessEpoch:businessEpochs.get(business)??0,
    };
    return {claims,sig:sign(null,Buffer.from(canonical(claims),'utf8'),key.privateKey).toString('base64url')};
  }
  // Verifier contains only public keys; no access to issuer private keys.
  // Atomic durable nonce consumption is a production dependency, NOT provided
  // by this in-memory proof. A real database verifier must implement it.
  function consume(token,{now,action=ACTION}={}) {
    const c=token?.claims;
    if(!strictClaims(c)||typeof token?.sig!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(token.sig))
      return {ok:false,reason:'MALFORMED'};
    if(!Number.isSafeInteger(now)||!allowedActions.has(action)||c.action!==action)
      return {ok:false,reason:'OPERATION'};
    if(c.exp<=now||c.iat>now+5||c.exp<=c.iat||c.exp-c.iat>MAX_TTL_SECONDS)
      return {ok:false,reason:'EXPIRED'};
    const key=publicVerifierKeys.get(c.kid);
    if(!key||key.revoked||c.iat<key.notBefore||c.exp>key.notAfter)
      return {ok:false,reason:'KEY_DENIED'};
    const signature=Buffer.from(token.sig,'base64url');
    if(signature.length!==64||!verify(null,Buffer.from(canonical(c),'utf8'),key.publicKey,signature))
      return {ok:false,reason:'SIGNATURE'};
    if((actorEpochs.get(c.sub)??-1)!==c.actorEpoch ||
       (businessEpochs.get(c.business)??-1)!==c.businessEpoch ||
       !memberships.has(`${c.sub}:${c.business}`))
      return {ok:false,reason:'REVOKED'};
    if(consumed.has(c.nonce))return {ok:false,reason:'REPLAY'};
    consumed.add(c.nonce);
    return {ok:true,actor:c.sub,business:c.business,action:c.action};
  }
  addKey('key_old',1000,2000);
  return {issue,consume,addKey,revokeKey,revokeActor,revokeBusiness,removeMember,publicVerifierKeys};
}
const ok=(value)=>assert.equal(value.ok,true,JSON.stringify(value));
const denied=(value)=>assert.equal(value.ok,false);

describe('Gate 2 R13 offline trusted assertion issuer and key lifecycle contract',()=>{
  it('01 legitimate assertion is operation-, audience-, actor-, tenant- and issuer-bound',()=>{
    const h=makeHarness();
    const token=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    ok(h.consume(token,{now:1101}));
    assert.equal(h.consume(token,{now:1102}).reason,'REPLAY');
  });
  it('02 cannot issue for a foreign business or unsigned operation',()=>{
    const h=makeHarness();
    assert.throws(()=>h.issue({kid:'key_old',actor:ACTOR_A,business:B,now:1100}),/MEMBERSHIP/);
    assert.throws(()=>h.issue({kid:'key_old',actor:ACTOR_A,business:A,action:'feedback:delete',now:1100}),/OPERATION/);
  });
  it('03 rejects edited tenant, actor, operation, audience and key ID even with otherwise valid signature',()=>{
    for(const field of ['business','sub','action','aud','kid','nonce','iss']){
      const h=makeHarness();const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
      t.claims[field]=({business:B,sub:ACTOR_B,action:'feedback:delete',aud:'other',kid:'key_unknown',nonce:randomUUID(),iss:'attacker'})[field];
      denied(h.consume(t,{now:1101}));
    }
  });
  it('04 rejects expired, not-yet-valid, invalid TTL and malformed claims',()=>{
    const h=makeHarness();
    const expired=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    assert.equal(h.consume(expired,{now:1160}).reason,'EXPIRED');
    const future=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1200});
    assert.equal(h.consume(future,{now:1100}).reason,'EXPIRED');
    assert.throws(()=>h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100,ttl:121}),/TTL/);
    denied(h.consume({claims:{},sig:'junk'},{now:1100}));
  });
  it('05 accepts overlapping signing keys while each individual key is valid',()=>{
    const h=makeHarness();h.addKey('key_new',1150,3000);
    ok(h.consume(h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1160}),{now:1161}));
    ok(h.consume(h.issue({kid:'key_new',actor:ACTOR_A,business:A,now:1160}),{now:1161}));
    assert.throws(()=>h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1980,ttl:60}),/KEY/);
  });
  it('06 key revocation denies outstanding tokens before expiration',()=>{
    const h=makeHarness();const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    h.revokeKey('key_old');assert.equal(h.consume(t,{now:1101}).reason,'KEY_DENIED');
  });
  it('07 actor revocation invalidates already issued assertions',()=>{
    const h=makeHarness();const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    h.revokeActor(ACTOR_A);assert.equal(h.consume(t,{now:1101}).reason,'REVOKED');
  });
  it('08 business revocation invalidates already issued assertions',()=>{
    const h=makeHarness();const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    h.revokeBusiness(A);assert.equal(h.consume(t,{now:1101}).reason,'REVOKED');
  });
  it('09 removed membership prevents issue and consumption of outstanding tokens',()=>{
    const h=makeHarness();const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    h.removeMember(ACTOR_A,A);assert.equal(h.consume(t,{now:1101}).reason,'REVOKED');
    assert.throws(()=>h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1102}),/MEMBERSHIP/);
  });
  it('10 replay nonce cannot be reused after first successful verification',()=>{
    const h=makeHarness();const nonce=randomUUID();
    const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100,nonce});
    ok(h.consume(t,{now:1101}));
    const t2=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100,nonce});
    assert.equal(h.consume(t2,{now:1102}).reason,'REPLAY');
  });
  it('11 verifier stores only public keys, not private signing capability',()=>{
    const h=makeHarness();
    for(const entry of h.publicVerifierKeys.values()){
      assert.equal(entry.publicKey.type,'public');
      assert.equal(Object.hasOwn(entry,'privateKey'),false);
    }
  });
  it('12 invalid signature and untrusted client-selected action fail closed',()=>{
    const h=makeHarness();
    const t=h.issue({kid:'key_old',actor:ACTOR_A,business:A,now:1100});
    const altered={...t,sig:'A'.repeat(86)};
    assert.equal(h.consume(altered,{now:1101}).reason,'SIGNATURE');
    assert.equal(h.consume(t,{now:1101,action:'feedback:delete'}).reason,'OPERATION');
    ok(h.consume(t,{now:1101}));
  });
});
