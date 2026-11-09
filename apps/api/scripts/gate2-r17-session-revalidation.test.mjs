/**
 * Gate 2 R17: offline exact-session, use-time verification contract.
 * Injected, synthetic persistence only. No DB, Hono route, key or issuer.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const A='a8000000-0000-4000-8000-000000000001';
const B='a8000000-0000-4000-8000-000000000002';
const USER='b8000000-0000-4000-8000-000000000001';
const OTHER='b8000000-0000-4000-8000-000000000002';
const ACTION='branches:list';
const MAX_AGE_MS=30_000;

function fixture(){
  const sid1=randomUUID(),sid2=randomUUID(),otherSid=randomUUID();
  const users=new Map([[USER,{active:true}],[OTHER,{active:true}]]);
  const sessions=new Map([
    [USER+':'+sid1,{user:USER,session:sid1,live:true,expiresAt:200_000}],
    [USER+':'+sid2,{user:USER,session:sid2,live:true,expiresAt:200_000}],
    [OTHER+':'+otherSid,{user:OTHER,session:otherSid,live:true,expiresAt:200_000}],
  ]);
  const members=new Set([USER+':'+A+':'+ACTION,OTHER+':'+B+':'+ACTION]);
  const businesses=new Set([A,B]);
  const contexts=new WeakMap();
  let unavailable=false;
  let revision=0;
  const audit=[];
  function setUnavailable(flag){unavailable=flag;}
  function revokeSession(user,sid){const row=sessions.get(user+':'+sid);if(row){row.live=false;revision++;}}
  function revokeAll(user){for(const row of sessions.values())if(row.user===user)row.live=false;revision++;}
  function disableUser(user){const row=users.get(user);if(row)row.active=false;revision++;}
  function removeMember(user,business){members.delete(user+':'+business+':'+ACTION);revision++;}
  function suspendBusiness(business){businesses.delete(business);revision++;}
  // The trusted authentication boundary supplies verified subject and sid.
  // Public caller must never construct this opaque context or select an actor.
  function authenticate({user,session,tokenExpMs,nowMs,impersonated=false}){
    if(impersonated)throw Error('IMPERSONATION_DENIED');
    if(typeof user!=='string'||typeof session!=='string'||!Number.isSafeInteger(nowMs)||
       !Number.isSafeInteger(tokenExpMs)||tokenExpMs<=nowMs)throw Error('AUTH_INVALID');
    const handle=Object.freeze(Object.create(null));
    contexts.set(handle,Object.freeze({user,session,tokenExpMs,createdAt:nowMs}));
    return handle;
  }
  async function issueIntent(context,{business,action=ACTION,nowMs,requestId=randomUUID()}){
    const b=context&&typeof context==='object'?contexts.get(context):null;
    if(!b)throw Error('UNTRUSTED_CONTEXT');
    if(!Number.isSafeInteger(nowMs)||nowMs<b.createdAt||nowMs-b.createdAt>MAX_AGE_MS||
       nowMs>=b.tokenExpMs)throw Error('CONTEXT_EXPIRED');
    if(!Number.isSafeInteger(nowMs)||typeof requestId!=='string'||!businesses.has(business)||action!==ACTION)
      throw Error('SCOPE_DENIED');
    // All persisted reads fail closed. No cached isLive/membership promise may
    // be substituted for the current use-time read. This is a simulated store.
    if(unavailable)throw Error('AUTHORITY_STORE_UNAVAILABLE');
    const currentRevision=revision;
    const user=users.get(b.user);
    const session=sessions.get(b.user+':'+b.session);
    if(!user?.active||!session||session.user!==b.user||session.session!==b.session||
       !session.live||session.expiresAt<=nowMs)throw Error('SESSION_REVOKED');
    if(!members.has(b.user+':'+business+':'+action))throw Error('MEMBERSHIP_REVOKED');
    // Models rechecking state after async inspection; production needs an
    // atomic authorization+side-effect boundary, not merely revision compare.
    await Promise.resolve();
    if(unavailable||revision!==currentRevision)throw Error('AUTHORITY_CHANGED');
    const intent=Object.freeze({actor:b.user,session:b.session,business,action,requestId,verifiedAtMs:nowMs});
    audit.push({actor:b.user,business,action,requestId});
    return intent; // unsigned, non-authorizing evidence for a design proof only
  }
  return {sid1,sid2,otherSid,authenticate,issueIntent,setUnavailable,revokeSession,
    revokeAll,disableUser,removeMember,suspendBusiness,audit};
}
const fail=async(fn,expected)=>assert.rejects(fn,new RegExp(expected));
const good=(h,session=h.sid1)=>h.authenticate({user:USER,session,tokenExpMs:100_000,nowMs:1000});
const issue=(h,c,more={})=>h.issueIntent(c,{business:A,nowMs:1001,requestId:randomUUID(),...more});

describe('Gate 2 R17 — exact persisted session and authorization use-time contract',()=>{
  it('01 active exact session, actor and membership may create unsigned intent',async()=>{
    const h=fixture(),c=good(h),x=await issue(h,c);
    assert.equal(x.actor,USER);assert.equal(x.session,h.sid1);assert.equal(h.audit.length,1);
  });
  it('02 arbitrary literal or clone of context cannot substitute authority',async()=>{
    const h=fixture(),c=good(h);
    await fail(()=>issue(h,{}),'UNTRUSTED_CONTEXT');
    await fail(()=>issue(h,{...c}),'UNTRUSTED_CONTEXT');
  });
  it('03 revoking exact session denies even if another same-user session remains live',async()=>{
    const h=fixture(),c=good(h);h.revokeSession(USER,h.sid1);
    await fail(()=>issue(h,c),'SESSION_REVOKED');
    const valid=good(h,h.sid2);assert.equal((await issue(h,valid)).actor,USER);
  });
  it('04 revoking other session does not falsely revoke this session',async()=>{
    const h=fixture(),c=good(h);h.revokeSession(USER,h.sid2);
    assert.equal((await issue(h,c)).actor,USER);
  });
  it('05 another user session cannot validate current subject',async()=>{
    const h=fixture();const c=h.authenticate({user:USER,session:h.otherSid,tokenExpMs:100_000,nowMs:1000});
    await fail(()=>issue(h,c),'SESSION_REVOKED');
  });
  it('06 revoke-all immediately denies next simulated privileged operation',async()=>{
    const h=fixture(),c=good(h);h.revokeAll(USER);await fail(()=>issue(h,c),'SESSION_REVOKED');
  });
  it('07 disabled actor cannot issue even with a still-live session',async()=>{
    const h=fixture(),c=good(h);h.disableUser(USER);await fail(()=>issue(h,c),'SESSION_REVOKED');
  });
  it('08 membership removal is evaluated at each use',async()=>{
    const h=fixture(),c=good(h);h.removeMember(USER,A);await fail(()=>issue(h,c),'MEMBERSHIP_REVOKED');
  });
  it('09 suspended business is denied',async()=>{
    const h=fixture(),c=good(h);h.suspendBusiness(A);await fail(()=>issue(h,c),'SCOPE_DENIED');
  });
  it('10 unavailable authorization store fails closed',async()=>{
    const h=fixture(),c=good(h);h.setUnavailable(true);
    await fail(()=>issue(h,c),'AUTHORITY_STORE_UNAVAILABLE');
  });
  it('11 token expiry and stale context deny',async()=>{
    const h=fixture(),c=good(h);
    await fail(()=>issue(h,c,{nowMs:100_000}),'CONTEXT_EXPIRED');
    await fail(()=>issue(h,c,{nowMs:31_002}),'CONTEXT_EXPIRED');
  });
  it('12 legacy/sessionless or impersonated source cannot gain authority',async()=>{
    const h=fixture();
    assert.throws(()=>h.authenticate({user:USER,session:undefined,tokenExpMs:100_000,nowMs:1000}),/AUTH_INVALID/);
    assert.throws(()=>h.authenticate({user:USER,session:h.sid1,tokenExpMs:100_000,nowMs:1000,impersonated:true}),/IMPERSONATION_DENIED/);
  });
  it('13 disallowed operation cannot use the session context',async()=>{
    const h=fixture(),c=good(h);await fail(()=>issue(h,c,{action:'settlement:write'}),'SCOPE_DENIED');
  });
  it('14 denies a revoked session immediately before next use, with no successful audit',async()=>{
    const h=fixture(),c=good(h);h.revokeSession(USER,h.sid1);
    await fail(()=>issue(h,c),'SESSION_REVOKED');assert.equal(h.audit.length,0);
  });
});
