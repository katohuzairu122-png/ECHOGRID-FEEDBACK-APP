import { describe, expect, it } from 'vitest';
import {
  partnerCreditAccountSchema,
  partnerCreditPolicySchema,
  partnerCreditRecoverySchema,
} from '@echo-grid-feedback/shared-types';

const id = 'd5c2eb93-d8c9-4b10-b62e-d19a136a68d5';

describe('Split 07 Block 1 inert Partner Credit contracts', () => {
  it('locks the non-cash PC-ECON/1 settings', () => {
    expect(partnerCreditPolicySchema.parse({ version:'PC-ECON/1', awardUnits:1, monthlyCap:10, vestDays:14, expiresAfterMonths:12 }).monthlyCap).toBe(10);
    expect(partnerCreditPolicySchema.safeParse({ version:'PC-ECON/1', awardUnits:2, monthlyCap:10, vestDays:14, expiresAfterMonths:12 }).success).toBe(false);
  });
  it('rejects negative available balances and unexpected cash units', () => {
    const account = { businessId:id, unit:'partner_credit', provisional:0, available:0, reserved:0, recoveryDue:0 };
    expect(partnerCreditAccountSchema.safeParse(account).success).toBe(true);
    expect(partnerCreditAccountSchema.safeParse({ ...account, available:-1 }).success).toBe(false);
    expect(partnerCreditAccountSchema.safeParse({ ...account, unit:'USD' }).success).toBe(false);
  });
  it('prevents recovery outstanding units exceeding the original obligation', () => {
    expect(partnerCreditRecoverySchema.safeParse({ reversalRef:id, businessId:id, unitsDue:1, unitsOutstanding:2 }).success).toBe(false);
  });
});
