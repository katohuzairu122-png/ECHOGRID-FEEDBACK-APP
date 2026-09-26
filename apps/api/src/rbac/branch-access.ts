import { AppError } from '../lib/errors';

export type BranchAccess = {
  businessWideAccess: boolean;
  branchId?: string;
};

/**
 * Resolves a handler-supplied branch against the scope authorized by tenant
 * middleware. A business-wide grant may select any branch; a branch grant is
 * permanently locked to the X-Branch-Id that earned its permissions.
 */
export function authorizedBranchId(
  access: BranchAccess,
  requestedBranchId?: string,
): string | undefined {
  if (access.businessWideAccess) return requestedBranchId;
  if (!access.branchId) {
    throw new AppError('A branch context is required for this role.', 403, 'BRANCH_CONTEXT_REQUIRED');
  }
  if (requestedBranchId && requestedBranchId !== access.branchId) {
    throw new AppError('You do not have access to this branch.', 403, 'BRANCH_ACCESS_DENIED');
  }
  return access.branchId;
}

export function assertBusinessWideAccess(access: BranchAccess): void {
  if (!access.businessWideAccess) {
    throw new AppError(
      'This operation requires business-wide access.',
      403,
      'BUSINESS_WIDE_ACCESS_REQUIRED',
    );
  }
}
