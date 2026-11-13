import type {
  LoyaltyAccountDto,
  BusinessPublicDto,
  CustomerMessagingUnreadSummaryDto,
} from '@echo-grid-feedback/shared-types';
import { customerApiFetch } from '@/lib/customer-api-client';
import { publicApiFetch } from '@/lib/public-api-client';
import { rethrowControlFlow } from '@/lib/rethrow-control-flow';
import { classifyWalletFailure, resolveWalletEntries } from '@/lib/loyalty-wallet';
import { LoyaltyWalletUnavailable, LoyaltyWalletView } from './wallet-view';

/**
 * "My loyalties": one card per business the customer has joined. Business names are not on LoyaltyAccountDto
 * (a business concern), so each public name is fetched alongside the accounts. A failed name lookup falls back
 * to a neutral label for that card only. A failed accounts read is NOT turned into an empty wallet: it reaches
 * the error boundary (and a 401 redirects to the customer login inside customerApiFetch).
 */
export default async function LoyaltyCustomerDashboardPage() {
  let accounts: LoyaltyAccountDto[];
  try {
    accounts = await customerApiFetch<LoyaltyAccountDto[]>('/loyalty/me/accounts');
  } catch (error) {
    rethrowControlFlow(error); // keeps the 401 redirect to the customer login
    if (classifyWalletFailure(error) === 'unavailable') return <LoyaltyWalletUnavailable />;
    throw error;
  }
  const entries = await resolveWalletEntries(accounts, async (businessId) => {
    const business = await publicApiFetch<BusinessPublicDto>(`/businesses/${businessId}/public`);
    return business.name;
  });
  // Cards with something new from the business get a mark. A failed read just shows no marks (but a signed-out
  // customer still goes to the login page, which rethrowControlFlow keeps).
  let unreadByBusiness: Record<string, number> = {};
  try {
    const unread = await customerApiFetch<CustomerMessagingUnreadSummaryDto>('/messaging/me/unread-count');
    unreadByBusiness = Object.fromEntries(unread.byBusiness.map((b) => [b.businessId, b.unreadMessages]));
  } catch (error) {
    rethrowControlFlow(error);
  }
  return <LoyaltyWalletView entries={entries} unreadByBusiness={unreadByBusiness} />;
}
