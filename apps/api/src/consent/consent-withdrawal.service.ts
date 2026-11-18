import type { Database } from '../db/client';
import { createRepositories } from '../repositories';
import {
  endActiveMembership,
  lockCustomerBusinessRelationship,
} from '../customer-relationships/membership-lifecycle';

/**
 * Customer-initiated consent withdrawal.
 *
 * Revoking a grant is a plain state change for every purpose except one:
 * `join_loyalty` is the consent the loyalty membership rests on, so
 * withdrawing it ends that membership (status `left`). Earning and redeeming
 * stop; the loyalty account and its points are kept and come back if the
 * customer joins again with fresh consent. Both changes commit together or not
 * at all, under the same per-customer-and-business lock join and leave take.
 */
export class ConsentWithdrawalService {
  constructor(private readonly db: Database) {}

  /**
   * Returns `true` when an active grant belonging to the customer was revoked,
   * and `false` for anything else (missing, another customer's, expired or
   * already revoked), so the route can answer 404 exactly as DEV-70 requires.
   */
  async revoke(grantId: string, customerId: string): Promise<boolean> {
    // An unlocked read, only to learn WHICH relationship this grant belongs
    // to; the revoke below re-checks that the grant is still active.
    const grant = await createRepositories(this.db).consentGrants.findOwned(grantId, customerId);
    if (!grant) return false;

    const businessId = grant.businessId;
    if (grant.purpose !== 'join_loyalty' || businessId === null) {
      return createRepositories(this.db).consentGrants.revoke(grantId, customerId);
    }

    return this.db.transaction(async (tx) => {
      await lockCustomerBusinessRelationship(tx, customerId, businessId);
      const repos = createRepositories(tx);

      const revoked = await repos.consentGrants.revokeReturning(grantId, customerId);
      if (!revoked) return false;

      const membership = await repos.customerMemberships.findByCustomerAndBusiness(
        customerId,
        businessId,
      );
      if (membership?.status === 'active') {
        await endActiveMembership(repos, membership);
      }
      return true;
    });
  }
}
