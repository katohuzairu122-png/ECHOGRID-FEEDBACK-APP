import type { LoyaltyAccountDto } from '@echo-grid-feedback/shared-types';
import { ApiError } from './api-error';

export interface WalletEntry {
  account: LoyaltyAccountDto;
  /** The business's public name, or null when it could not be loaded (the view shows a neutral fallback). */
  businessName: string | null;
}

/**
 * Resolves each business name independently. One business that fails to load must not take the whole wallet
 * down: it falls back to a neutral label instead. Never throws for a name lookup.
 */
export async function resolveWalletEntries(
  accounts: readonly LoyaltyAccountDto[],
  fetchName: (businessId: string) => Promise<string>,
): Promise<WalletEntry[]> {
  const results = await Promise.allSettled(
    accounts.map((account) => fetchName(account.businessId)),
  );
  return sortWalletEntries(
    accounts.map((account, index) => {
      const result = results[index];
      return {
        account,
        businessName: result?.status === 'fulfilled' && result.value.trim() ? result.value : null,
      };
    }),
  );
}

/**
 * Active memberships first, then the most recent visit, then name. Deterministic: ties never reorder between
 * renders. Points are deliberately NOT used to order or to total: a point belongs to one business and is not
 * comparable across businesses.
 */
export function sortWalletEntries(entries: readonly WalletEntry[]): WalletEntry[] {
  return [...entries].sort((a, b) => {
    const statusRank = (e: WalletEntry) => (e.account.status === 'active' ? 0 : 1);
    if (statusRank(a) !== statusRank(b)) return statusRank(a) - statusRank(b);
    const visit = (e: WalletEntry) =>
      e.account.lastVisitAt ? Date.parse(e.account.lastVisitAt) : 0;
    if (visit(a) !== visit(b)) return visit(b) - visit(a);
    const nameA = a.businessName ?? '￿';
    const nameB = b.businessName ?? '￿';
    return nameA.localeCompare(nameB) || a.account.id.localeCompare(b.account.id);
  });
}

/**
 * How the wallet reacts to a failed accounts read. A rate limit or an outage shows an explicit, retryable
 * "unavailable" state: it is never rendered as an empty wallet (which would tell a customer they have no
 * memberships). Anything else is not handled here and reaches the error boundary. A 401 never gets this far:
 * customerApiFetch redirects to the customer login.
 */
export function classifyWalletFailure(error: unknown): 'unavailable' | 'rethrow' {
  if (!(error instanceof ApiError)) return 'unavailable';
  return error.status === 429 || error.status >= 500 ? 'unavailable' : 'rethrow';
}
