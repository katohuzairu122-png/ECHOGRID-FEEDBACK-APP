import type { Database } from '../db/client';
import { createRepositories, type Business } from '../repositories';
import { RoleProvisioningService } from '../rbac/role-provisioning.service';
import { SubscriptionProvisioningService } from '../billing/subscription-provisioning.service';
import { AppError } from '../lib/errors';
import type { UpdateBusinessInput } from '@echo-grid-feedback/shared-types';

export interface CreateBusinessInput {
  name: string;
  slug: string;
}

export interface CreateBusinessResult {
  businessId: string;
  ownerRoleId: string;
}

/**
 * Creating a business, seeding its default roles, and granting the creator
 * Owner must all succeed or fail together, so this owns a transaction
 * spanning all three -- the one exception to "services depend on
 * repositories, not the raw Database" elsewhere in this codebase.
 * RoleProvisioningService stays repo-injected and non-transactional; here it
 * is simply handed transaction-scoped repositories to work with.
 */
export class BusinessService {
  constructor(private readonly db: Database) {}

  async createBusiness(
    input: CreateBusinessInput,
    ownerId: string,
  ): Promise<CreateBusinessResult> {
    return this.db.transaction(async (tx) => {
      const repos = createRepositories(tx);

      const existing = await repos.businesses.findBySlug(input.slug);
      if (existing) {
        throw new AppError(`Slug "${input.slug}" is already taken.`, 409, 'SLUG_TAKEN');
      }

      const business = await repos.businesses.create({
        name: input.name,
        slug: input.slug,
        createdBy: ownerId,
      });

      const roleProvisioning = new RoleProvisioningService(repos);
      const roleIds = await roleProvisioning.seedDefaultRoles(business.id, ownerId);
      const ownerRoleId = roleIds.Owner;
      if (!ownerRoleId) {
        throw new AppError('Failed to provision the Owner role.', 500, 'ROLE_PROVISIONING_FAILED');
      }

      await repos.userBusinessRoles.grant({
        userId: ownerId,
        businessId: business.id,
        branchId: null,
        roleId: ownerRoleId,
        createdBy: ownerId,
      });

      // Billing Block 8 -- every business starts on a free, card-less trial
      // (see subscription-provisioning.service.ts's doc comment for why).
      // Part of the same transaction as everything else above: a business
      // must never exist without a subscription row for longer than it
      // takes the plan catalog to be seeded.
      const subscriptionProvisioning = new SubscriptionProvisioningService(repos);
      await subscriptionProvisioning.provisionTrial(business.id, ownerId);

      return { businessId: business.id, ownerRoleId };
    });
  }

  /**
   * Businesses the user has at least one active role grant in, deduped --
   * a user can hold separate grants at the same business across different
   * branches, which would otherwise surface as duplicate rows.
   */
  async listForUser(userId: string): Promise<Business[]> {
    const repos = createRepositories(this.db);
    const grants = await repos.userBusinessRoles.listForUser(userId);
    const uniqueBusinessIds = [...new Set(grants.map((grant) => grant.businessId))];

    const businesses = await Promise.all(
      uniqueBusinessIds.map((id) => repos.businesses.findById(id)),
    );
    return businesses.filter((business): business is Business => business !== undefined);
  }

  /**
   * Updates a business's display name and/or locale/currency/timezone
   * defaults (i18n & Multi-Currency Block 1). The only mutation path for
   * those three fields -- without this, every business is permanently
   * stuck on the 'en'/'USD'/'UTC' seed defaults. No transaction needed:
   * single-table write, unlike createBusiness's multi-repo bootstrapping.
   */
  async updateBusiness(
    id: string,
    patch: UpdateBusinessInput,
    updatedBy: string,
  ): Promise<Business> {
    const repos = createRepositories(this.db);
    const updated = await repos.businesses.update(id, patch, updatedBy);
    if (!updated) {
      throw new AppError('Business not found.', 404, 'BUSINESS_NOT_FOUND');
    }
    return updated;
  }
}
