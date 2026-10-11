import { describe, expect, it } from 'vitest';
import { PartnerCreditApplicationIntegrityReader } from '../src/billing/partner-credit-application-integrity.reader';
import {
  billingPartnerCreditApplications, businessSubscriptions,
  partnerCreditAccounts, partnerCreditAwardDecisions,
  partnerCreditLots, partnerCreditReservations,
} from '../src/db/schema';
import type { Db } from '../src/db/client';

const date=new Date('2026-10-10T00:00:00.000Z');
const fixture=()=>{
  const app={ id:'app',reservationId:'reservation',businessId:'business',subscriptionId:'subscription',
    unitsApplied:1,terminalState:'applied',invoiceRef:'invoice',providerSuccessRef:'stripe-event',appliedAt:date };
  const reservation={id:'reservation',businessId:'business',decisionId:'decision',lotId:'lot',
    accountId:'account',units:1,state:'consumed',terminalAt:new Date('2026-10-10T01:00:00.000Z'),
    expiresAt:new Date('2026-10-11T00:00:00.000Z')};
  const decision={id:'decision',businessId:'business',state:'vested'};
  const lot={id:'lot',decisionId:'decision',accountId:'account',status:'consumed'};
  const account={id:'account',businessId:'business'};
  const subscription={id:'subscription',businessId:'business',stripeSubscriptionId:'sub_stripe'};
  return {app,reservation,decision,lot,account,subscription};
};
function reader(data:ReturnType<typeof fixture>) {
  const rows=new Map<unknown,unknown>([
    [billingPartnerCreditApplications,data.app],[partnerCreditReservations,data.reservation],
    [partnerCreditAwardDecisions,data.decision],[partnerCreditLots,data.lot],
    [partnerCreditAccounts,data.account],[businessSubscriptions,data.subscription],
  ]);
  const db={select:()=>({from:(table:unknown)=>({
    where:()=>({limit:async()=>{const x=rows.get(table);return x?[x]:[];}}),
  })})} as unknown as Db;
  return new PartnerCreditApplicationIntegrityReader(db);
}
describe('Split 08 read-only cross-table CE-1 consistency',()=>{
  it('never grants trusted Stripe consumption even when all references match',async()=>{
    expect(await reader(fixture()).inspect('app')).toEqual({kind:'relations_consistent_unverified'});
  });
  it('rejects cross-business subscription and reservation aliases',async()=>{
    const a=fixture();a.subscription.businessId='another';
    expect(await reader(a).inspect('app')).toMatchObject({kind:'inconsistent',
      reason:'CROSS_TENANT_OR_LOT_MISMATCH'});
    const b=fixture();b.reservation.businessId='another';
    expect(await reader(b).inspect('app')).toMatchObject({kind:'inconsistent'});
  });
  it('rejects mismatched award-lot provenance',async()=>{
    const a=fixture();a.lot.decisionId='another';
    expect(await reader(a).inspect('app')).toMatchObject({kind:'inconsistent'});
  });
  it('rejects a nonterminal reservation and missing provider references',async()=>{
    const a=fixture();a.reservation.state='reserved';
    expect(await reader(a).inspect('app')).toMatchObject({kind:'inconsistent',
      reason:'TERMINAL_STATE_OR_TIMESTAMP_MISMATCH'});
    const b=fixture();b.app.providerSuccessRef='';
    expect(await reader(b).inspect('app')).toMatchObject({kind:'inconsistent',
      reason:'PROVIDER_REFERENCE_MISSING'});
  });
});
