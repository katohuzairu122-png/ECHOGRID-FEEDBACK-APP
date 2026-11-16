import { describe, expect, it } from 'vitest';
import { assertVerifiedPhone, assertVerifiedPhoneFor, hasVerifiedPhone } from './customer-verification';

describe('verified phone gate', () => {
  it('requires both a phone number and a verification time', () => {
    expect(hasVerifiedPhone({ phone: '+15551234567', phoneVerifiedAt: new Date() })).toBe(true);
    expect(hasVerifiedPhone({ phone: '+15551234567', phoneVerifiedAt: null })).toBe(false);
    expect(hasVerifiedPhone({ phone: null, phoneVerifiedAt: new Date() })).toBe(false);
    expect(hasVerifiedPhone({})).toBe(false);
  });

  it('fails closed with a stable machine code and the feature, for an unverified or missing customer', () => {
    for (const customer of [undefined, { phone: '+15551234567', phoneVerifiedAt: null }, { phone: null }]) {
      expect(() => assertVerifiedPhoneFor(customer, 'community')).toThrowError(
        expect.objectContaining({ status: 403, code: 'PHONE_VERIFICATION_REQUIRED', details: { feature: 'community' } }),
      );
    }
  });

  it('passes for a verified customer and reads the status from the repository, never from the caller', async () => {
    const verified = { customers: { findById: async () => ({ phone: '+15551234567', phoneVerifiedAt: new Date() }) } };
    await expect(assertVerifiedPhone(verified, 'c1', 'network')).resolves.toBeUndefined();
    const unverified = { customers: { findById: async () => ({ phone: '+15551234567', phoneVerifiedAt: null }) } };
    await expect(assertVerifiedPhone(unverified, 'c1', 'join_additional_business')).rejects.toMatchObject({
      code: 'PHONE_VERIFICATION_REQUIRED',
    });
  });
});
