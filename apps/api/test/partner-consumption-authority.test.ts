import { describe, expect, it } from 'vitest';
import {
  inspectPartnerCreditConservation, rejectUnverifiedConsumptionEvidence,
} from '../src/partner-credits/partner-consumption-authority.contract';

describe('Split 07 / Split 08 CE-1 fail-closed boundary', () => {
  it('rejects fabricated, client-provided or merely well-formed consumption assertions', () => {
    expect(() => rejectUnverifiedConsumptionEvidence({
      evidenceVersion:'partner-consumption/1',
      applicationState:'applied',
      businessId:crypto.randomUUID(),
      applicationRef:crypto.randomUUID(),
    })).toThrow('PARTNER_CONSUMPTION_AUTHORITY_NOT_ESTABLISHED');
    expect(() => rejectUnverifiedConsumptionEvidence(null)).toThrow();
  });

  it('reconciles the supported prebilling buckets against lots and obligations', () => {
    expect(inspectPartnerCreditConservation({
      account:{provisional:1,available:1,reserved:0,recoveryDue:2},
      lots:[
        {id:'one',units:1,availableUnits:0,status:'provisional'},
        {id:'two',units:1,availableUnits:1,status:'available'},
        {id:'three',units:1,availableUnits:0,status:'reversed'},
      ],
      obligations:[{unitsDue:2,unitsOutstanding:2}],
    })).toEqual({valid:true,violations:[]});
  });

  it('detects projected overstatement and debt inconsistency', () => {
    const result=inspectPartnerCreditConservation({
      account:{provisional:2,available:2,reserved:0,recoveryDue:0},
      lots:[{id:'one',units:1,availableUnits:1,status:'available'}],
      obligations:[{unitsDue:1,unitsOutstanding:1}],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain('PARTNER_PROVISIONAL_PROJECTION_MISMATCH');
    expect(result.violations).toContain('PARTNER_AVAILABLE_PROJECTION_MISMATCH');
    expect(result.violations).toContain('PARTNER_RECOVERY_PROJECTION_MISMATCH');
  });

  it('never infers consumed/reserved proof from a lot status', () => {
    for(const state of ['consumed','reserved'] as const) {
      const result=inspectPartnerCreditConservation({
        account:{provisional:0,available:0,reserved:0,recoveryDue:0},
        lots:[{id:'unverified',units:1,availableUnits:0,status:state}],
        obligations:[],
      });
      expect(result.valid).toBe(false);
      expect(result.violations).toContain('PARTNER_CONSUMPTION_ALLOCATION_AUTHORITY_MISSING');
    }
  });

  it('rejects duplicate lots, negative buckets and invalid obligation quantities', () => {
    const result=inspectPartnerCreditConservation({
      account:{provisional:-1,available:0,reserved:1,recoveryDue:0},
      lots:[
        {id:'same',units:1,availableUnits:0,status:'provisional'},
        {id:'same',units:1,availableUnits:2,status:'available'},
      ],
      obligations:[{unitsDue:1,unitsOutstanding:2}],
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toContain('PARTNER_ACCOUNT_INVALID_BUCKET');
    expect(result.violations).toContain('PARTNER_LOT_ID_DUPLICATE');
    expect(result.violations).toContain('PARTNER_LOT_INVALID_QUANTITY');
    expect(result.violations).toContain('PARTNER_RECOVERY_OBLIGATION_INVALID');
  });
});
