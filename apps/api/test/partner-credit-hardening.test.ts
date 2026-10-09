import { describe, expect, it } from 'vitest';
import { partnerCreditAccountSchema, partnerCreditPolicySchema } from '@echo-grid-feedback/shared-types';

describe('Split 07 Block 1 economic immutability surface', () => {
  it('rejects an unapproved award rate', () => {
    const policy={version:'PC-ECON/1',awardUnits:2,monthlyCap:10,vestDays:14,expiresAfterMonths:12};
    expect(partnerCreditPolicySchema.safeParse(policy).success).toBe(false);
  });
  it('rejects money-denominated Partner Credit balances', () => {
    const account={businessId:'5d62d675-7878-4183-9e9d-af143f1c0d48',unit:'USD',available:0,provisional:0,reserved:0,recoveryDue:0};
    expect(partnerCreditAccountSchema.safeParse(account).success).toBe(false);
  });
});
