/**
 * Gate 2 design-only authorization boundary acceptance model.
 * This model mints no signed claims and grants no database capability.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const contracts=Object.freeze({
  perTenantLogin: { viableUnderOneSharedHyperdrive:false, requiresOneCredentialPerTenant:true },
  ownerLogin: { viableUnderOneSharedHyperdrive:false, bypassesRls:true },
  mutableGuc: { viableUnderOneSharedHyperdrive:false, callerCanSpoof:true },
  restrictedBroker: { viableUnderOneSharedHyperdrive:true, needsIndependentIssuer:true },
});
function classify(selection){
  if(!Object.hasOwn(contracts,selection))return 'DENY_UNRECOGNIZED';
  return contracts[selection].viableUnderOneSharedHyperdrive
    ? 'CANDIDATE_ONLY_REQUIRES_FULL_PROOF' : 'DENY_CURRENT_RUNTIME';
}
// This is a negative-capability proof. No authorization is issued.
function evaluate({role,verifiedEvidence,issuerBound,exactSession,tenant,allowedTenant,action,
  allowedAction,nonceConsumed,revoked,storeAvailable,branchAllowed,impersonated=false,
  customerToken=false,scopeByGucOnly=false,directSql=false}){
  if(role!=='restricted_broker'||directSql||scopeByGucOnly)return false;
  if(!verifiedEvidence||!issuerBound||!exactSession||impersonated||customerToken)return false;
  if(!storeAvailable||revoked||nonceConsumed||!branchAllowed)return false;
  if(!tenant||tenant!==allowedTenant||action!==allowedAction)return false;
  return true;
}
const safe=()=>({role:'restricted_broker',verifiedEvidence:true,issuerBound:true,exactSession:true,
  tenant:'A',allowedTenant:'A',action:'branches:list',allowedAction:'branches:list',
  nonceConsumed:false,revoked:false,storeAvailable:true,branchAllowed:true});
describe('Gate 2 proposed restricted broker — design-only denial contract',()=>{
  it('01 excludes owner/BYPASSRLS runtime',()=>assert.equal(classify('ownerLogin'),'DENY_CURRENT_RUNTIME'));
  it('02 excludes mutable GUC as authority',()=>assert.equal(classify('mutableGuc'),'DENY_CURRENT_RUNTIME'));
  it('03 excludes per-tenant principals with unproven shared pooling',()=>assert.equal(classify('perTenantLogin'),'DENY_CURRENT_RUNTIME'));
  it('04 identifies broker as candidate, not approved implementation',()=>assert.equal(classify('restrictedBroker'),'CANDIDATE_ONLY_REQUIRES_FULL_PROOF'));
  it('05 rejects unknown architecture',()=>assert.equal(classify('unknown'),'DENY_UNRECOGNIZED'));
  it('06 rejects owner privilege',()=>assert.equal(evaluate({...safe(),role:'neondb_owner'}),false));
  it('07 rejects direct arbitrary SQL',()=>assert.equal(evaluate({...safe(),directSql:true}),false));
  it('08 rejects GUC-only tenant context',()=>assert.equal(evaluate({...safe(),scopeByGucOnly:true}),false));
  it('09 rejects forged or unbound identity evidence',()=>{for(const key of ['verifiedEvidence','issuerBound','exactSession'])assert.equal(evaluate({...safe(),[key]:false}),false);});
  it('10 rejects cross-tenant and cross-operation attempts',()=>{assert.equal(evaluate({...safe(),tenant:'B'}),false);assert.equal(evaluate({...safe(),action:'settlement:write'}),false);});
  it('11 rejects consumed nonces and revoked sessions',()=>{assert.equal(evaluate({...safe(),nonceConsumed:true}),false);assert.equal(evaluate({...safe(),revoked:true}),false);});
  it('12 rejects storage outage and missing branch authorization',()=>{assert.equal(evaluate({...safe(),storeAvailable:false}),false);assert.equal(evaluate({...safe(),branchAllowed:false}),false);});
  it('13 refuses impersonation and customer-token substitution',()=>{assert.equal(evaluate({...safe(),impersonated:true}),false);assert.equal(evaluate({...safe(),customerToken:true}),false);});
  it('14 positive case is only an abstract model, not a real capability',()=>assert.equal(evaluate(safe()),true));
});
