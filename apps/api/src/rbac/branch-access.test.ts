import { describe, expect, it } from 'vitest';
import { assertBusinessWideAccess, authorizedBranchId } from './branch-access';

describe('branch access', () => {
  it('lets a business-wide grant select any branch or the whole business', () => {
    expect(authorizedBranchId({ businessWideAccess: true }, 'branch-b')).toBe('branch-b');
    expect(authorizedBranchId({ businessWideAccess: true })).toBeUndefined();
  });

  it('locks a branch-scoped grant to its authorized branch', () => {
    const access = { businessWideAccess: false, branchId: 'branch-a' };
    expect(authorizedBranchId(access)).toBe('branch-a');
    expect(authorizedBranchId(access, 'branch-a')).toBe('branch-a');
    expect(() => authorizedBranchId(access, 'branch-b')).toThrowError(
      expect.objectContaining({ code: 'BRANCH_ACCESS_DENIED', status: 403 }),
    );
  });

  it('fails closed when a branch-scoped grant has no branch context', () => {
    expect(() => authorizedBranchId({ businessWideAccess: false })).toThrowError(
      expect.objectContaining({ code: 'BRANCH_CONTEXT_REQUIRED', status: 403 }),
    );
  });

  it('reserves business-wide operations for business-wide grants', () => {
    expect(() => assertBusinessWideAccess({ businessWideAccess: true })).not.toThrow();
    expect(() =>
      assertBusinessWideAccess({ businessWideAccess: false, branchId: 'branch-a' }),
    ).toThrowError(expect.objectContaining({ code: 'BUSINESS_WIDE_ACCESS_REQUIRED', status: 403 }));
  });
});
