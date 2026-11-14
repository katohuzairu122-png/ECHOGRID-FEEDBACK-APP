import { AppError } from './errors';

/**
 * Limited access (owner ruling 2026-11-13): after a platform-rules violation a
 * customer can be limited for a period. They stay signed in and keep their own
 * account, balances and history, but these features are off until the end
 * date, which then passes by itself:
 *
 *   - joining a business ('join_business'): signing up to new businesses
 *   - taking part in surveys ('surveys'): which is also how Community Points
 *     are earned today
 *
 * Not yet enforced (documented gaps, see the design document): loyalty
 * feedback rewards at a business, Community Points redemption and the
 * Community feed, because none of those customer flows exist or are wired yet.
 */
export type LimitedFeature = 'join_business' | 'surveys';

export function isCustomerLimited(
  customer: { limitedUntil?: Date | null },
  now: Date = new Date(),
): boolean {
  return Boolean(customer.limitedUntil && customer.limitedUntil.getTime() > now.getTime());
}

export async function assertCustomerNotLimited(
  repos: {
    customers: { findById(id: string): Promise<{ limitedUntil?: Date | null } | undefined> };
  },
  customerId: string,
  _feature: LimitedFeature,
): Promise<void> {
  const customer = await repos.customers.findById(customerId);
  if (customer && isCustomerLimited(customer)) {
    throw new AppError(
      'This feature is temporarily unavailable on your account.',
      403,
      'CUSTOMER_LIMITED',
    );
  }
}
