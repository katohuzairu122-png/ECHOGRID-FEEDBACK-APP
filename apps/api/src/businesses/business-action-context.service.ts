import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';
import { assertBusinessIsUsable } from '../rbac/business-access';

export class BusinessActionContextService {
  constructor(
    private readonly repos: Pick<Repositories, 'userBusinessRoles' | 'businesses' | 'branches'>,
  ) {}

  async listForUser(
    userId: string,
    businessId: string,
  ): Promise<{ branchId: string | null; branchName: string | null }[]> {
    const grants = await this.repos.userBusinessRoles.listForUserAtBusiness(userId, businessId);
    if (!grants.length) throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    assertBusinessIsUsable(await this.repos.businesses.findById(businessId));
    const branchIds = [...new Set(grants.map((grant) => grant.branchId))];
    const contexts: { branchId: string | null; branchName: string | null }[] = [];
    for (const branchId of branchIds) {
      if (branchId === null) contexts.push({ branchId: null, branchName: null });
      else {
        const branch = await this.repos.branches.findById(branchId, businessId);
        if (branch) contexts.push({ branchId: branch.id, branchName: branch.name });
      }
    }
    return contexts;
  }
}
