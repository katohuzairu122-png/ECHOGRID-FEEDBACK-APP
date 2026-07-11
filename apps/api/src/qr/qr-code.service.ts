import type { Repositories } from '../repositories';
import type { QrCode } from '../repositories/qr-code.repository';
import { AppError } from '../lib/errors';

/**
 * 20 lowercase-hex characters (~78-80 bits of entropy from
 * crypto.randomUUID(), version/variant nibbles aside) -- unguessable enough
 * for a semi-public identifier (similar security stakes to an unlisted
 * video URL, not a password), while staying short enough to keep the
 * resulting QR code simple and reliable to scan. crypto.randomUUID() is
 * used as the entropy source specifically because it's a
 * Cloudflare-documented Workers runtime API with no compatibility
 * uncertainty, rather than reaching for btoa()/Buffer on unverified
 * availability here.
 */
function generateToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

export class QrCodeService {
  constructor(private readonly repos: Pick<Repositories, 'qrCodes'>) {}

  /**
   * Every branch gets its QR code lazily, on first request, rather than
   * eagerly at branch-creation time -- keeps BranchService/createBranch
   * untouched and this service fully self-contained, instead of extending
   * BusinessService's narrowly-scoped "transactional multi-entity create"
   * exception to branches too.
   */
  async getOrCreateActiveForBranch(
    branchId: string,
    businessId: string,
    createdBy: string,
  ): Promise<QrCode> {
    const existing = await this.repos.qrCodes.findActiveForBranch(branchId, businessId);
    if (existing) return existing;

    return this.repos.qrCodes.create({
      businessId,
      branchId,
      token: generateToken(),
      createdBy,
    });
  }

  /**
   * Revokes the current active code (if any) and issues a new one. Revoking
   * first, then inserting, relies on the partial unique index
   * (qr_codes_branch_type_active_key) as a backstop against a concurrent
   * regenerate landing two "active" rows for the same branch -- the same
   * check-then-write risk tolerance BranchService takes with slug
   * uniqueness, not a scenario this method retries around.
   */
  async regenerate(branchId: string, businessId: string, actorId: string): Promise<QrCode> {
    const existing = await this.repos.qrCodes.findActiveForBranch(branchId, businessId);
    if (existing) {
      await this.repos.qrCodes.revoke(existing.id, businessId, actorId);
    }

    return this.repos.qrCodes.create({
      businessId,
      branchId,
      token: generateToken(),
      createdBy: actorId,
    });
  }

  /**
   * Public entry point: resolves an anonymous token to the QR code row.
   * Revoked and unknown tokens produce the identical 404 -- enumeration
   * resistance, same principle as login's identical error for a wrong
   * password vs. a nonexistent account.
   */
  async resolveToken(token: string): Promise<QrCode> {
    const qrCode = await this.repos.qrCodes.findActiveByToken(token);
    if (!qrCode) {
      throw new AppError('This QR code is no longer valid.', 404, 'QR_CODE_NOT_FOUND');
    }
    return qrCode;
  }
}
