import type { Repositories } from '../repositories';
import type { UserBusinessRole } from '../repositories/user-business-role.repository';

/**
 * Framework-agnostic authorization logic, mirroring how AuthService relates
 * to auth.routes.ts: this holds no Hono-specific code, so it's unit
 * testable (Block 9) without a running Worker. The tenant-context and
 * require-permission middleware are thin Hono wrappers around this.
 */
export class AuthorizationService {
  constructor(
    private readonly repos: Pick<Repositories, 'userBusinessRoles' | 'permissions'>,
  ) {}

  /** Non-empty return means the user is a member of this business. */
  async getMembership(userId: string, businessId: string): Promise<UserBusinessRole[]> {
    return this.repos.userBusinessRoles.listForUserAtBusiness(userId, businessId);
  }

  async getEffectivePermissions(
    userId: string,
    businessId: string,
    branchId?: string,
  ): Promise<Set<string>> {
    return this.repos.permissions.findEffectiveKeys(userId, businessId, branchId);
  }
}
