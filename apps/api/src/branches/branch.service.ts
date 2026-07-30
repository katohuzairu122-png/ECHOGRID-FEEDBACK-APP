import type { Repositories } from '../repositories';
import type { Branch, NewBranch } from '../repositories/branch.repository';
import { AppError } from '../lib/errors';
import type { CreateBranchInput, UpdateBranchInput } from '@echo-grid-feedback/shared-types';

/**
 * Branch business logic: enforces slug uniqueness per business (the DB
 * index does this too -- see branches.ts's uniqueIndex -- this check exists
 * to return a clean 409 instead of surfacing a raw constraint-violation
 * error) and is the home for future orchestration a bare repository call
 * shouldn't own (e.g. QR code generation on create, once that module
 * ships). Repository-injected, not raw Database -- branch operations are
 * single-table and don't need BusinessService's transaction-owning
 * exception.
 */
export class BranchService {
  constructor(private readonly repos: Pick<Repositories, 'branches'>) {}

  async listBranches(
    businessId: string,
    options: { limit?: number | undefined; offset?: number | undefined } = {},
  ): Promise<Branch[]> {
    return this.repos.branches.listByBusiness(businessId, options);
  }

  async getBranch(id: string, businessId: string): Promise<Branch> {
    const branch = await this.repos.branches.findById(id, businessId);
    if (!branch) {
      throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');
    }
    return branch;
  }

  async createBranch(
    businessId: string,
    input: CreateBranchInput,
    createdBy: string,
  ): Promise<Branch> {
    const existing = await this.repos.branches.findBySlug(businessId, input.slug);
    if (existing) {
      throw new AppError(
        `Slug "${input.slug}" is already taken at this business.`,
        409,
        'SLUG_TAKEN',
      );
    }

    return this.repos.branches.create({
      ...input,
      businessId,
      createdBy,
    } satisfies NewBranch);
  }

  async updateBranch(
    id: string,
    businessId: string,
    patch: UpdateBranchInput,
    updatedBy: string,
  ): Promise<Branch> {
    // Confirms the branch exists (and belongs to this business) before any
    // slug check or write -- a 404 should win over a 409 when both would
    // otherwise apply.
    await this.getBranch(id, businessId);

    if (patch.slug) {
      const existing = await this.repos.branches.findBySlug(businessId, patch.slug);
      if (existing && existing.id !== id) {
        throw new AppError(
          `Slug "${patch.slug}" is already taken at this business.`,
          409,
          'SLUG_TAKEN',
        );
      }
    }

    const updated = await this.repos.branches.update(id, businessId, patch, updatedBy);
    if (!updated) {
      throw new AppError('Branch not found.', 404, 'BRANCH_NOT_FOUND');
    }
    return updated;
  }

  async deleteBranch(id: string, businessId: string, deletedBy: string): Promise<void> {
    // Confirms existence first so DELETE on an unknown id returns 404, not
    // a silent no-op 204 -- repository softDelete() doesn't report whether
    // a row actually matched.
    await this.getBranch(id, businessId);
    await this.repos.branches.softDelete(id, businessId, deletedBy);
  }
}
