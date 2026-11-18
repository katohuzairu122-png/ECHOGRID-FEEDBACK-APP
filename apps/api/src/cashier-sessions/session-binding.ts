import type { Db } from '../db/client';
import { AppError } from '../lib/errors';
import { createRepositories } from '../repositories';

/**
 * CASHIER-AUTH-02C (D-5): the deterministic ordering between a branch switch and a counter mutation.
 *
 * A cashier session is bound to one branch. A switch takes an EXCLUSIVE lock on the session rows and ends the old session in
 * the same transaction; a purchase or redemption confirmation calls this FIRST inside its own transaction, which takes a
 * SHARED lock on the live, still-bound session row until it commits. So exactly one of two orders can happen:
 *  - the mutation commits first: it keeps the branch it was authorised for, and the switch then proceeds;
 *  - the switch commits first: the mutation finds no live row for its old branch and is refused, before it writes anything.
 * A mutation can therefore never be silently re-attributed to another branch, and a stale token can never write after a switch.
 */
export interface CashierSessionBinding {
  userId: string;
  sessionId: string;
  branchId: string | null;
}

export async function assertCashierSessionBound(tx: Db, binding: CashierSessionBinding): Promise<void> {
  const live = await createRepositories(tx).refreshTokens.lockLiveBoundSessionShared(
    binding.userId, binding.sessionId, binding.branchId, Date.now(),
  );
  if (!live) {
    throw new AppError('Your branch or session changed. Reload and try again.', 409, 'CASHIER_SESSION_CHANGED');
  }
}
