import {
  CURRENT_JOIN_LOYALTY_CONSENT_VERSION,
  JOIN_LOYALTY_CONSENT_VERSIONS,
  joinCustomerMembershipSchema,
  joinLoyaltyProgramSchema,
} from '@echo-grid-feedback/shared-types';
import { describe, expect, it } from 'vitest';

/**
 * Split 01: explicit JOIN_LOYALTY consent is part of the request contract, not a UI convention.
 * Both join endpoints validate with this one schema, so a client that omits or falsifies the
 * acceptance is rejected before any membership, account or consent row can be written.
 */
const valid = { qrToken: 'qr-token', consentAccepted: true };

describe('join consent contract', () => {
  it('accepts an explicit acceptance and records the current wording when no version is sent', () => {
    const parsed = joinCustomerMembershipSchema.parse(valid);
    expect(parsed.consentAccepted).toBe(true);
    expect(parsed.consentVersion).toBe(CURRENT_JOIN_LOYALTY_CONSENT_VERSION);
  });

  it.each([
    ['missing', undefined],
    ['false', false],
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['null', null],
  ])('rejects consentAccepted when it is %s', (_label, value) => {
    const result = joinCustomerMembershipSchema.safeParse({ ...valid, consentAccepted: value });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path[0])).toContain('consentAccepted');
  });

  it('rejects a consent version that never shipped', () => {
    const result = joinCustomerMembershipSchema.safeParse({ ...valid, consentVersion: 'v99' });
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.map((issue) => issue.path[0])).toContain('consentVersion');
  });

  it('accepts every shipped consent version, and the current one is among them', () => {
    for (const version of JOIN_LOYALTY_CONSENT_VERSIONS) {
      expect(
        joinCustomerMembershipSchema.parse({ ...valid, consentVersion: version }).consentVersion,
      ).toBe(version);
    }
    expect(JOIN_LOYALTY_CONSENT_VERSIONS).toContain(CURRENT_JOIN_LOYALTY_CONSENT_VERSION);
  });

  it('still requires a QR token', () => {
    expect(joinCustomerMembershipSchema.safeParse({ consentAccepted: true }).success).toBe(false);
    expect(joinCustomerMembershipSchema.safeParse({ ...valid, qrToken: '' }).success).toBe(false);
  });

  it('is the one schema behind both join endpoints', () => {
    expect(joinLoyaltyProgramSchema).toBe(joinCustomerMembershipSchema);
  });
});
