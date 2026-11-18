import { sql } from 'drizzle-orm';
import type { Transaction } from '../db/client';
import type { BusinessCustomerMembership, Repositories } from '../repositories';

/**
 * Serialises every change to ONE customer's relationship with ONE business:
 * joining, re-joining, leaving and withdrawing the join consent. They all take
 * this lock first, so two of them can never interleave their reads and writes
 * (a join racing a leave would otherwise re-create the consent the leave just
 * revoked, or reactivate a membership that was being ended).
 *
 * Transaction-scoped: released when the caller's transaction ends. The lock is
 * only ever taken FIRST in a transaction, before any row lock, so lifecycle
 * transactions cannot deadlock one another. Spending paths do not take it;
 * they use the membership row's SHARE lock instead (see
 * `CustomerMembershipRepository.findByCustomerAndBusinessForShare`).
 */
export async function lockCustomerBusinessRelationship(
  tx: Pick<Transaction, 'execute'>,
  customerId: string,
  businessId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customer_business_relationship:${customerId}:${businessId}`}, 0))`,
  );
}

/**
 * Ends an ACTIVE membership and withdraws the consent that created it, inside
 * the caller's transaction (which must already hold the relationship lock).
 *
 * The loyalty account and its points are not touched: the balance is kept and
 * is available again if the customer re-joins with fresh consent. Returns the
 * left membership, or `undefined` when the membership was not active any more
 * (for example it was suspended between the caller's read and this write), in
 * which case nothing was changed.
 */
export async function endActiveMembership(
  repos: Pick<Repositories, 'customerMemberships' | 'consentGrants'>,
  membership: Pick<BusinessCustomerMembership, 'id' | 'customerId' | 'businessId'>,
): Promise<BusinessCustomerMembership | undefined> {
  const left = await repos.customerMemberships.markLeft(membership.id);
  if (!left) return undefined;
  await repos.consentGrants.revokeActiveForPurpose(
    membership.customerId,
    membership.businessId,
    'join_loyalty',
  );
  return left;
}
