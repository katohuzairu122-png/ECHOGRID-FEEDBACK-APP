import { AppError } from './errors';

/**
 * Verified-phone gate (CUSTOMER-PHONE-01). A phone number entered at registration is only a claim; it proves nothing
 * until the customer has completed a verification challenge. The verification status lives in
 * customers.phone_verified_at, never in a token or a client-supplied field, and is checked server-side.
 *
 * Verification is required ONLY for:
 *   - 'join_additional_business': joining a business after the customer already has a relationship with another one
 *   - 'community': Community participation
 *   - 'network': restricted Network features
 * It is NOT required for the first business join, earning at a business the customer already belongs to, or being
 * found by a cashier (business-scoped, see CustomerLookupService). Existing memberships stay fully usable.
 */
export type VerifiedPhoneFeature = 'join_additional_business' | 'community' | 'network';

export const PHONE_VERIFICATION_REQUIRED_CODE = 'PHONE_VERIFICATION_REQUIRED';

export function hasVerifiedPhone(customer: { phone?: string | null; phoneVerifiedAt?: Date | null }): boolean {
  return Boolean(customer.phone && customer.phoneVerifiedAt);
}

export function assertVerifiedPhoneFor(
  customer: { phone?: string | null; phoneVerifiedAt?: Date | null } | undefined,
  feature: VerifiedPhoneFeature,
): void {
  if (customer && hasVerifiedPhone(customer)) return;
  throw new AppError(
    'Verify your phone number to continue.',
    403,
    PHONE_VERIFICATION_REQUIRED_CODE,
    { feature },
  );
}

export async function assertVerifiedPhone(
  repos: {
    customers: {
      findById(id: string): Promise<{ phone?: string | null; phoneVerifiedAt?: Date | null } | undefined>;
    };
  },
  customerId: string,
  feature: VerifiedPhoneFeature,
): Promise<void> {
  assertVerifiedPhoneFor(await repos.customers.findById(customerId), feature);
}
