import { describe, expect, it, vi } from 'vitest';
import { BusinessActionContextService } from './business-action-context.service';
function repos(grants: { branchId: string | null }[], active = true) {
  return {
    userBusinessRoles: { listForUserAtBusiness: vi.fn().mockResolvedValue(grants) },
    businesses: {
      findById: vi.fn().mockResolvedValue({ status: active ? 'active' : 'suspended' }),
    },
    branches: {
      findById: vi
        .fn()
        .mockImplementation(async (id: string, businessId: string) =>
          id === 'branch-a' && businessId === 'business-a' ? { id, name: 'Main' } : undefined,
        ),
    },
  };
}
function service(mock: ReturnType<typeof repos>) {
  return new BusinessActionContextService(
    mock as unknown as ConstructorParameters<typeof BusinessActionContextService>[0],
  );
}
describe('own business action contexts', () => {
  it('returns only valid own branches and deduplicates grants', async () => {
    const mock = repos([
      { branchId: 'branch-a' },
      { branchId: 'branch-a' },
      { branchId: 'foreign' },
    ]);
    expect(await service(mock).listForUser('staff', 'business-a')).toEqual([
      { branchId: 'branch-a', branchName: 'Main' },
    ]);
    expect(mock.branches.findById).toHaveBeenCalledWith('foreign', 'business-a');
  });
  it('preserves an authorized business-wide context', async () => {
    expect(await service(repos([{ branchId: null }])).listForUser('staff', 'business-a')).toEqual([
      { branchId: null, branchName: null },
    ]);
  });
  it('does not inspect a business or branches for a non-member', async () => {
    const mock = repos([]);
    await expect(service(mock).listForUser('staff', 'foreign')).rejects.toMatchObject({
      status: 404,
    });
    expect(mock.businesses.findById).not.toHaveBeenCalled();
    expect(mock.branches.findById).not.toHaveBeenCalled();
  });
  it('fails closed for an inactive business', async () => {
    const mock = repos([{ branchId: 'branch-a' }], false);
    await expect(service(mock).listForUser('staff', 'business-a')).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.branches.findById).not.toHaveBeenCalled();
  });
});
