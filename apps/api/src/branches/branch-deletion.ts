import type { Repositories } from '../repositories';
import { BranchService } from './branch.service';

/**
 * SEC-CASHIER-02D-R2: deleting a branch ends the cashier sessions bound to it, in the SAME transaction.
 *
 * Request-time checks already refuse a session on a removed branch (tenant context and refresh both re-read the branch), so this
 * is not an open door: it removes the latent live session row, and the lock keeps a concurrent switch or sign-in from creating one
 * (the 02C-R1 ordering: user rows first, ascending id, then the deletion and revocation). Run it inside `db.transaction`.
 */
export async function deleteBranchEndingSessions(
  repos: Pick<Repositories, 'branches' | 'users' | 'refreshTokens'>,
  id: string,
  businessId: string,
  deletedBy: string,
): Promise<{ sessionsRevoked: number }> {
  await repos.users.lockForBranchRemoval(businessId, id);
  await new BranchService(repos).deleteBranch(id, businessId, deletedBy);
  const sessionsRevoked = await repos.refreshTokens.revokeCashierSessionsForBranch(businessId, id);
  return { sessionsRevoked };
}
