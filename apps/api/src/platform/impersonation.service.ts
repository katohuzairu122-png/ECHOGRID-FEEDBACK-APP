import type { Repositories } from '../repositories';
import { AppError } from '../lib/errors';
import { signImpersonationToken } from '../auth/jwt';

export interface ImpersonateInput {
  targetUserId: string;
  businessId: string;
}

export interface ImpersonationResult {
  accessToken: string;
  expiresAt: Date;
  targetUser: { id: string; email: string; fullName: string };
}

/**
 * Mints a short-lived token that lets a platform admin see the product
 * exactly as one specific staff member of a business would. The two checks
 * below are the entire safety boundary: target user exists and is active,
 * and they actually hold an active role grant at the named business --
 * without the second check, an admin could impersonate ANY user in the
 * system while claiming to be "at" a business that user has nothing to do
 * with, which would make the resulting session's tenant-scoped permissions
 * meaningless. Route handler (platform/business-directory.routes.ts) is
 * responsible for the requirePlatformRole gate and audit logging; this
 * class only knows how to mint a validated token.
 */
export class ImpersonationService {
  constructor(
    private readonly repos: Pick<Repositories, 'users' | 'userBusinessRoles'>,
    private readonly accessSecret: string,
  ) {}

  async impersonate(input: ImpersonateInput, adminUserId: string): Promise<ImpersonationResult> {
    const targetUser = await this.repos.users.findById(input.targetUserId);
    if (!targetUser) {
      throw new AppError('Target user not found.', 404, 'USER_NOT_FOUND');
    }
    if (targetUser.status !== 'active') {
      throw new AppError('Cannot impersonate an inactive user.', 409, 'USER_NOT_ACTIVE');
    }

    const grants = await this.repos.userBusinessRoles.listForUserAtBusiness(
      input.targetUserId,
      input.businessId,
    );
    if (grants.length === 0) {
      throw new AppError(
        'This user has no active role at the target business.',
        409,
        'USER_NOT_A_MEMBER',
      );
    }

    const { token, expiresAt } = await signImpersonationToken(
      input.targetUserId,
      adminUserId,
      this.accessSecret,
    );

    return {
      accessToken: token,
      expiresAt,
      targetUser: { id: targetUser.id, email: targetUser.email, fullName: targetUser.fullName },
    };
  }
}
