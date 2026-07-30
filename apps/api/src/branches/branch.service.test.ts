import { describe, it, expect, beforeEach } from 'vitest';
import { BranchService } from './branch.service';
import type { Branch, NewBranch } from '../repositories/branch.repository';

/**
 * Minimal in-memory fake, same shape/spirit as auth.service.test.ts's --
 * enough of BranchRepository's interface for BranchService to run against,
 * nothing more. BranchRepository's own queries (single-table, and/eq
 * filters, no joins) are simple enough that this fake gives real confidence;
 * unlike PermissionRepository.findEffectiveKeys (integration-tested instead,
 * Block 9 of the Foundation), there's no risk of the fake silently
 * duplicating logic a mock would fail to catch. The one thing a fake CAN'T
 * verify -- whether the businessId+slug UNIQUE INDEX itself actually exists
 * and is enforced by Postgres -- is covered separately in
 * test/integration/branch-slug-uniqueness.integration.test.ts.
 */
function createFakeBranchRepo() {
  const branches = new Map<string, Branch>();

  return {
    async findById(id: string, businessId: string): Promise<Branch | undefined> {
      const branch = branches.get(id);
      return branch && branch.businessId === businessId && !branch.isDeleted
        ? branch
        : undefined;
    },
    async findBySlug(businessId: string, slug: string): Promise<Branch | undefined> {
      return [...branches.values()].find(
        (b) => b.businessId === businessId && b.slug === slug && !b.isDeleted,
      );
    },
    async listByBusiness(
      businessId: string,
      options: { limit?: number; offset?: number } = {},
    ): Promise<Branch[]> {
      const all = [...branches.values()].filter(
        (b) => b.businessId === businessId && !b.isDeleted,
      );
      const offset = options.offset ?? 0;
      const limit = options.limit ?? all.length;
      return all.slice(offset, offset + limit);
    },
    async create(input: NewBranch): Promise<Branch> {
      const branch: Branch = {
        id: (input.id as string) ?? crypto.randomUUID(),
        businessId: input.businessId,
        name: input.name,
        slug: input.slug,
        addressLine1: input.addressLine1 ?? null,
        addressLine2: input.addressLine2 ?? null,
        city: input.city ?? null,
        stateProvince: input.stateProvince ?? null,
        postalCode: input.postalCode ?? null,
        countryCode: input.countryCode ?? null,
        timezone: input.timezone ?? 'UTC',
        latitude: input.latitude ?? null,
        longitude: input.longitude ?? null,
        status: input.status ?? 'active',
        createdAt: new Date(),
        createdBy: input.createdBy ?? null,
        updatedAt: new Date(),
        updatedBy: input.updatedBy ?? null,
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
      };
      branches.set(branch.id, branch);
      return branch;
    },
    async update(
      id: string,
      businessId: string,
      patch: Partial<Omit<NewBranch, 'id' | 'businessId'>>,
      updatedBy: string,
    ): Promise<Branch | undefined> {
      const branch = branches.get(id);
      if (!branch || branch.businessId !== businessId || branch.isDeleted) return undefined;
      Object.assign(branch, patch, { updatedBy, updatedAt: new Date() });
      return branch;
    },
    async softDelete(id: string, businessId: string, deletedBy: string): Promise<void> {
      const branch = branches.get(id);
      if (branch && branch.businessId === businessId) {
        branch.isDeleted = true;
        branch.deletedAt = new Date();
        branch.deletedBy = deletedBy;
      }
    },
  };
}

const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';
const ACTOR = 'actor-user-id';

describe('BranchService', () => {
  let repos: { branches: ReturnType<typeof createFakeBranchRepo> };
  let service: BranchService;

  beforeEach(() => {
    repos = { branches: createFakeBranchRepo() };
    service = new BranchService(repos as unknown as ConstructorParameters<typeof BranchService>[0]);
  });

  it('creates a branch scoped to the given business', async () => {
    const branch = await service.createBranch(
      BUSINESS_A,
      { name: 'Downtown', slug: 'downtown' },
      ACTOR,
    );
    expect(branch.businessId).toBe(BUSINESS_A);
    expect(branch.slug).toBe('downtown');
  });

  it('rejects a duplicate slug at the same business', async () => {
    await service.createBranch(BUSINESS_A, { name: 'Downtown', slug: 'downtown' }, ACTOR);

    await expect(
      service.createBranch(BUSINESS_A, { name: 'Downtown Again', slug: 'downtown' }, ACTOR),
    ).rejects.toMatchObject({ code: 'SLUG_TAKEN', status: 409 });
  });

  it('allows the same slug at a different business -- uniqueness is per-tenant, not global', async () => {
    await service.createBranch(BUSINESS_A, { name: 'Downtown', slug: 'downtown' }, ACTOR);

    await expect(
      service.createBranch(BUSINESS_B, { name: 'Downtown', slug: 'downtown' }, ACTOR),
    ).resolves.toMatchObject({ businessId: BUSINESS_B, slug: 'downtown' });
  });

  it('getBranch throws 404 for an unknown id', async () => {
    await expect(service.getBranch('does-not-exist', BUSINESS_A)).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
      status: 404,
    });
  });

  it('getBranch throws 404 for a branch that belongs to a different business -- a lookup can never cross tenant boundaries', async () => {
    const branch = await service.createBranch(
      BUSINESS_A,
      { name: 'Downtown', slug: 'downtown' },
      ACTOR,
    );

    await expect(service.getBranch(branch.id, BUSINESS_B)).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
    });
  });

  it('updateBranch applies a partial patch', async () => {
    const branch = await service.createBranch(
      BUSINESS_A,
      { name: 'Downtown', slug: 'downtown' },
      ACTOR,
    );

    const updated = await service.updateBranch(branch.id, BUSINESS_A, { city: 'Austin' }, ACTOR);
    expect(updated.city).toBe('Austin');
    expect(updated.name).toBe('Downtown'); // untouched fields survive a partial patch
  });

  it('updateBranch throws 404 before checking for a slug conflict', async () => {
    await expect(
      service.updateBranch('does-not-exist', BUSINESS_A, { slug: 'new-slug' }, ACTOR),
    ).rejects.toMatchObject({ code: 'BRANCH_NOT_FOUND' });
  });

  it('updateBranch allows a branch to keep its own existing slug', async () => {
    const branch = await service.createBranch(
      BUSINESS_A,
      { name: 'Downtown', slug: 'downtown' },
      ACTOR,
    );

    await expect(
      service.updateBranch(branch.id, BUSINESS_A, { slug: 'downtown', city: 'Austin' }, ACTOR),
    ).resolves.toMatchObject({ slug: 'downtown', city: 'Austin' });
  });

  it('updateBranch rejects renaming into a slug already used by ANOTHER branch at the same business', async () => {
    await service.createBranch(BUSINESS_A, { name: 'Downtown', slug: 'downtown' }, ACTOR);
    const uptown = await service.createBranch(
      BUSINESS_A,
      { name: 'Uptown', slug: 'uptown' },
      ACTOR,
    );

    await expect(
      service.updateBranch(uptown.id, BUSINESS_A, { slug: 'downtown' }, ACTOR),
    ).rejects.toMatchObject({ code: 'SLUG_TAKEN' });
  });

  it('deleteBranch soft-deletes: the branch no longer appears in list or get', async () => {
    const branch = await service.createBranch(
      BUSINESS_A,
      { name: 'Downtown', slug: 'downtown' },
      ACTOR,
    );

    await service.deleteBranch(branch.id, BUSINESS_A, ACTOR);

    await expect(service.getBranch(branch.id, BUSINESS_A)).rejects.toMatchObject({
      code: 'BRANCH_NOT_FOUND',
    });
    expect(await service.listBranches(BUSINESS_A)).toHaveLength(0);
  });

  it('deleteBranch throws 404 for an unknown id rather than a silent no-op', async () => {
    await expect(service.deleteBranch('does-not-exist', BUSINESS_A, ACTOR)).rejects.toMatchObject(
      { code: 'BRANCH_NOT_FOUND' },
    );
  });
});
