import { describe, it, expect } from 'vitest';
import { applyCustomerSanctionSchema } from '@echo-grid-feedback/shared-types';

describe('applyCustomerSanctionSchema', () => {
  const until = new Date(Date.now() + 86_400_000).toISOString();
  it('requires an end date for a suspension and forbids it otherwise', () => {
    expect(
      applyCustomerSanctionSchema.safeParse({ action: 'suspend', reason: 'Fraud pattern' }).success,
    ).toBe(false);
    expect(
      applyCustomerSanctionSchema.safeParse({
        action: 'suspend',
        reason: 'Fraud pattern',
        suspendedUntil: until,
      }).success,
    ).toBe(true);
    expect(
      applyCustomerSanctionSchema.safeParse({
        action: 'ban',
        reason: 'Fraud pattern',
        suspendedUntil: until,
      }).success,
    ).toBe(false);
  });
  it('requires a real reason', () => {
    expect(applyCustomerSanctionSchema.safeParse({ action: 'warning', reason: '  ' }).success).toBe(
      false,
    );
    expect(
      applyCustomerSanctionSchema.safeParse({ action: 'warning', reason: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
  it('allows skipWarning only for suspend or ban', () => {
    expect(
      applyCustomerSanctionSchema.safeParse({
        action: 'warning',
        reason: 'Fraud pattern',
        skipWarning: true,
      }).success,
    ).toBe(false);
    expect(
      applyCustomerSanctionSchema.safeParse({
        action: 'ban',
        reason: 'Fraud pattern',
        skipWarning: true,
      }).success,
    ).toBe(true);
  });
});
