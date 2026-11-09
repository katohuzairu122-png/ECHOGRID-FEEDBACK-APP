/**
 * Gate 2 R16: test-only cryptographically verified authentication evidence.
 * NOT a production token issuer, Hono middleware, or database broker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const A='a8000000-0000-4000-8000-000000000001';
const B='a8000000-0000-4000-8000-000000000002';
const USER='b8000000-0000-4000-8000-000000000001';
const OTHER='b8000000-0000-4000-8000-000000000002';
const ADMIN='b8000000-0000-4000-8000-000000000003';
const ACT='branches:list';
const AUD='echogrid:actor-evidence:r16';
const ISS='echogrid:test-idp:r16';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TTL=60;
const json=(v)=>Buffer.from(JSON.stringify(v)).toString('base64url');
function harness(){
  const key=randomBytes(32); // ephemeral, test-only, never exported
  const sessions=new Map([[USER,{active:true,version:1}],[OTHER,{active:true,version:1}],[ADMIN,{active:true,version:1}]]);
  const businesses=new Map([[A,true],[B,true]]);
  const memberships=new Set([USER+':'+A+':'+ACT,OTHER+':'+B+':'+ACT]);
  const used=new Set();
  const audit=[];
  const signed=(body)=>{const h=json({alg:'HS256',typ:'JWT'}),p=json(body);
    return h+'.'+p+'.'+createHmac('sha256',key).update(h+'.'+p).digest('base64url');};
  // This fixture simulates an externally validated identity provider. No public
  // arbitrary-actor minting API is implemented or authorized in production.
  function fixtureActorToken(sub,now,extra={}){
    return signed({iss:ISS,aud:AUD,sub,type:'access',sid:randomUUID(),
      iat:now,exp:now+MAX_TTL,sessionVersion:sessions.get(sub)?.version??0,...extra});
  }
  function parse(token,now){
    if(typeof token!=='string'||token.length>4096)throw Error('EVIDENCE_MALFORMED');
    const parts=token.split('.');
    if(parts.length!==3||parts.some(p=>!/^[A-Za-z0-9_-]+$/.test(p)))throw Error('EVIDENCE_MALFORMED');
    const [h,p,s]=parts;
    const expected=createHmac('sha256',key).update(h+'.'+p).digest();
    const actual=Buffer.from(s,'base64url');
    if(actual.length!==expected.length||!timingSafeEqual(expected,actual))throw Error('EVIDENCE_SIGNATURE');
    let header,claims;
    try{header=JSON.parse(Buffer.from(h,'base64url').toString('utf8'));
      claims=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));}catch{throw Error('EVIDENCE_MALFORMED');}
    if(header?.alg!=='HS256'||header?.typ!=='JWT'||Object.keys(header).length!==2||
       !claims||Object.getPrototypeOf(claims)!==Object.prototype ||
       Object.keys(claims).sort().join(',')!=='aud,exp,iat,iss,sessionVersion,sid,sub,type'||
       claims.iss!==ISS||claims.aud!==AUD||claims.type!=='access'||!UUID.test(claims.sub)||
       !UUID.test(claims.sid)||!Number.isSafeInteger(claims.iat)||
       !Number.isSafeInteger(claims.exp)||!Number.isSafeInteger(now)||
       claims.iat>now||claims.exp<=now||claims.exp-claims.iat>MAX_TTL||
       !Number.isSafeInteger(claims.sessionVersion))
      throw Error('EVIDENCE_CLAIMS');
    const active=sessions.get(claims.sub);
    if(!active?.active||active.version!==claims.sessionVersion)throw Error('EVIDENCE_SESSION_REVOKED');
    return claims;
  }
  function grant(token,scope,now){
    const c=parse(token,now);
    if(!scope||Object.getPrototypeOf(scope)!==Object.prototype||
       Object.keys(scope).sort().join(',')!=='environment,operation,requestId,tenant'||
       scope.environment!=='staging'||scope.operation!==ACT||
       !UUID.test(scope.tenant)||!UUID.test(scope.requestId))
      throw Error('SCOPE_INVALID');
    if(!businesses.get(scope.tenant)||
       !memberships.has(c.sub+':'+scope.tenant+':'+scope.operation))throw Error('AUTHORIZATION_DENIED');
    const id=c.sid+':'+scope.requestId+':'+scope.tenant+':'+scope.operation;
    if(used.has(id))throw Error('EVIDENCE_REPLAY');
    used.add(id);
    const intent=Object.freeze({actor:c.sub,session:c.sid,tenant:scope.tenant,
      operation:scope.operation,requestId:scope.requestId,environment:scope.environment,
      issuedAt:now,expiry:Math.min(c.exp,now+MAX_TTL)});
    audit.push({event:'AUTHENTICATED_INTENT',actor:c.sub,tenant:scope.tenant,requestId:scope.requestId});
    return intent; // unsigned intent, never database-authorizing
  }
  function revokeUser(user){const x=sessions.get(user);if(x){x.version++;x.active=false;}}
  function removeMember(user,tenant){memberships.delete(user+':'+tenant+':'+ACT);}
  function suspend(tenant){businesses.set(tenant,false);}
  return {fixtureActorToken,grant,revokeUser,removeMember,suspend,audit};
}
const scope=(tenant=A,operation=ACT,environment='staging',requestId=randomUUID())=>
  ({tenant,operation,environment,requestId});
const denied=(fn,part)=>assert.throws(fn,new RegExp(part));
describe('Gate 2 R16 — isolated evidence and delegation security contract',()=>{
  it('01 verified active user binds actor from signed evidence only',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000),s=scope(),r=h.grant(t,s,1001);
    assert.equal(r.actor,USER);assert.equal(r.tenant,A);assert.equal(h.audit.length,1);
  });
  it('02 forged signature denied',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000);
    const parts=t.split('.');parts[2]='A'.repeat(43);
    denied(()=>h.grant(parts.join('.'),scope(),1001),'SIGNATURE');
  });
  it('03 caller-supplied actor claim cannot replace signed subject',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000);
    denied(()=>h.grant(t,{...scope(),actor:OTHER},1001),'SCOPE_INVALID');
  });
  it('04 different tenant lacks current membership',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000);
    denied(()=>h.grant(t,scope(B),1001),'AUTHORIZATION_DENIED');
  });
  it('05 unsupported operations and environment denied',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000);
    denied(()=>h.grant(t,scope(A,'settlement:write'),1001),'SCOPE_INVALID');
    denied(()=>h.grant(t,scope(A,ACT,'production'),1001),'SCOPE_INVALID');
  });
  it('06 same session and request cannot be replayed',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000),s=scope();
    h.grant(t,s,1001);denied(()=>h.grant(t,s,1002),'REPLAY');
  });
  it('07 expired, premature and unsupported JWT claims denied',()=>{
    const h=harness();
    denied(()=>h.grant(h.fixtureActorToken(USER,1000),scope(),1060),'CLAIMS');
    denied(()=>h.grant(h.fixtureActorToken(USER,1020),scope(),1001),'CLAIMS');
    denied(()=>h.grant(h.fixtureActorToken(USER,1000,{type:'refresh'}),scope(),1001),'CLAIMS');
    denied(()=>h.grant(h.fixtureActorToken(USER,1000,{aud:'another-api'}),scope(),1001),'CLAIMS');
  });
  it('08 signed impersonation claims cannot silently inherit user authority',()=>{
    const h=harness();
    denied(()=>h.grant(h.fixtureActorToken(USER,1000,{impersonatedBy:ADMIN}),scope(),1001),'CLAIMS');
  });
  it('09 revoked active session denies new authorization evidence',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000);
    h.revokeUser(USER);denied(()=>h.grant(t,scope(),1001),'SESSION_REVOKED');
  });
  it('10 membership removal and business suspension deny signed evidence',()=>{
    const x=harness(),tx=x.fixtureActorToken(USER,1000);
    x.removeMember(USER,A);denied(()=>x.grant(tx,scope(),1001),'AUTHORIZATION_DENIED');
    const y=harness(),ty=y.fixtureActorToken(USER,1000);
    y.suspend(A);denied(()=>y.grant(ty,scope(),1001),'AUTHORIZATION_DENIED');
  });
  it('11 token without a session and malformed opaque evidence denied',()=>{
    const h=harness();
    denied(()=>h.grant(h.fixtureActorToken(USER,1000,{sid:undefined}),scope(),1001),'CLAIMS');
    denied(()=>h.grant('bad.token',scope(),1001),'MALFORMED');
  });
  it('12 different actor cannot use another actor tenant membership',()=>{
    const h=harness(),t=h.fixtureActorToken(OTHER,1000);
    denied(()=>h.grant(t,scope(A),1001),'AUTHORIZATION_DENIED');
  });
  it('13 no successful audit record for invalid proof',()=>{
    const h=harness(),t=h.fixtureActorToken(USER,1000);
    denied(()=>h.grant(t,scope(B),1001),'AUTHORIZATION_DENIED');
    assert.equal(h.audit.length,0);
  });
});