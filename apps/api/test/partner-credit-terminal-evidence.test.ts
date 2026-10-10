import { describe, expect, it } from 'vitest';
import {
  assertMatchingTerminalApplication, assertReservationTransition,
  unresolvedTerminalApplication,
  type ReservedPartnerCredit, type TerminalCreditApplicationEvidence,
} from '../src/billing/partner-credit-terminal-evidence.contract';

const reservation: ReservedPartnerCredit={
  reservationRef:'reservation-1',businessId:'business-1',decisionId:'decision-1',
  lotId:'lot-1',invoiceIntentRef:'intent-1',units:1,
  state:'reserved',expiresAt:'2026-11-01T00:00:00.000Z',
};
const evidence: TerminalCreditApplicationEvidence={
  evidenceVersion:'partner-consumption/1',applicationRef:'application-1',
  reservationRef:'reservation-1',invoiceRef:'invoice-1',
  subscriptionRef:'subscription-1',businessId:'business-1',
  decisionId:'decision-1',lotId:'lot-1',unitsApplied:1,
  terminalState:'applied',providerSuccessRef:'provider-1',
  appliedAt:'2026-10-20T00:00:00.000Z',
};
const now=new Date('2026-10-21T00:00:00.000Z');

describe('Split 08 reservation and terminal application CE-1 (inert contract)',()=>{
  it('rejects missing authoritative application',()=>{
    expect(()=>assertMatchingTerminalApplication(reservation,unresolvedTerminalApplication(),now))
      .toThrow('SPLIT08_TERMINAL_APPLICATION_NOT_VERIFIED');
    expect(()=>assertMatchingTerminalApplication(reservation,{kind:'not_terminal'},now))
      .toThrow('SPLIT08_TERMINAL_APPLICATION_NOT_VERIFIED');
  });
  it('validates matched server-side facts only after trusted database lookup',()=>{
    expect(assertMatchingTerminalApplication(reservation,{kind:'verified',evidence},now))
      .toEqual(evidence);
  });
  it('rejects mismatched tenant and allocation',()=>{
    for(const invalid of [{businessId:'other'},{lotId:'other'},{reservationRef:'other'},{decisionId:'other'},{unitsApplied:2 as 1}]){
      expect(()=>assertMatchingTerminalApplication(reservation,{
        kind:'verified',evidence:{...evidence,...invalid},
      },now)).toThrow('SPLIT08_CREDIT_ALLOCATION_MISMATCH');
    }
  });
  it('rejects fabricated terminal status or missing provider success',()=>{
    expect(()=>assertMatchingTerminalApplication(reservation,{
      kind:'verified',evidence:{...evidence,providerSuccessRef:''},
    },now)).toThrow('SPLIT08_TERMINAL_EVIDENCE_INVALID');
  });
  it('rejects expiry and future-dated application claims',()=>{
    expect(()=>assertMatchingTerminalApplication(reservation,{
      kind:'verified',evidence:{...evidence,appliedAt:'2026-12-01T00:00:00.000Z'},
    },now)).toThrow('SPLIT08_TERMINAL_APPLICATION_OUTSIDE_RESERVATION');
  });
  it('permits only reserved -> released or consumed transitions',()=>{
    expect(()=>assertReservationTransition('reserved','released')).not.toThrow();
    expect(()=>assertReservationTransition('reserved','consumed')).not.toThrow();
    for(const [a,b] of [['released','consumed'],['consumed','released'],['reserved','reserved']] as const){
      expect(()=>assertReservationTransition(a,b)).toThrow('SPLIT08_RESERVATION_TRANSITION_DENIED');
    }
  });
  it('refuses a terminal claim when reservation already released',()=>{
    expect(()=>assertMatchingTerminalApplication({...reservation,state:'released'},{
      kind:'verified',evidence,
    },now)).toThrow('SPLIT08_RESERVATION_NOT_ACTIVE');
  });
});
