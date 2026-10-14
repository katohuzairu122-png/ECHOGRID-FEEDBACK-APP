import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';
import { assertBusinessIsUsable } from '../rbac/business-access';

export class BusinessActionContextService {
  constructor(
    private readonly repos: Pick<
      Repositories,
      'userBusinessRoles' | 'businesses' | 'branches' | 'permissions'
    >,
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
    // Match the existing branch-list boundary: a business-wide grant plus
    // branches:view is required to discover other branches in this business.
    if (
      branchIds.includes(null) &&
      (await this.repos.permissions.findEffectiveKeys(userId, businessId)).has('branches:view')
    ) {
      const pageSize = 20;
      for (let offset = 0; ; offset += pageSize) {
        const rows = await this.repos.branches.listByBusiness(businessId, {
          limit: pageSize,
          offset,
        });
        for (const branch of rows) {
          if (
            branch.businessId === businessId &&
            !contexts.some((context) => context.branchId === branch.id)
          ) {
            contexts.push({ branchId: branch.id, branchName: branch.name });
          }
        }
        if (rows.length < pageSize) break;
      }
    }
    return contexts;
  }
}
