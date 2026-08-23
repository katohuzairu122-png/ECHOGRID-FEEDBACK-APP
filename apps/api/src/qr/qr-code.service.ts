import type { Repositories } from '../repositories';
import type { QrCode } from '../repositories/qr-code.repository';
import type { Bindings } from '../config/env';
import type { QrTokenPayload } from './qr-token';
import { AppError } from '../lib/errors';
import { signQrToken, verifyQrToken } from './qr-token';

/** Returned by every method that issues a token -- the row itself, plus the
 * freshly-signed value to hand back to the caller. Never persisted (see
 * db/schema/qr-codes.ts's doc comment on why the old `token` column was
 * dropped); signed fresh on every read instead. */
export interface IssuedQrCode {
  qrCode: QrCode;
  token: string;
}

export class QrCodeService {
  constructor(
    private readonly repos: Pick<Repositories, 'qrCodes' | 'fraudSignals'>,
    private readonly secrets: Pick<Bindings, 'QR_TOKEN_SECRET' | 'QR_TOKEN_SECRET_PREVIOUS'>,
  ) {}

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
  ): Promise<IssuedQrCode> {
    const existing = await this.repos.qrCodes.findActiveForBranch(branchId, businessId);
    const qrCode = existing ?? (await this.repos.qrCodes.create({ businessId, branchId, createdBy }));
    return this.issue(qrCode);
  }

  /**
   * Revokes the current active code (if any) and issues a new one. Revoking
   * first, then inserting, relies on the partial unique index
   * (qr_codes_branch_type_active_key) as a backstop against a concurrent
   * regenerate landing two "active" rows for the same branch -- the same
   * check-then-write risk tolerance BranchService takes with slug
   * uniqueness, not a scenario this method retries around.
   */
  async regenerate(branchId: string, businessId: string, actorId: string): Promise<IssuedQrCode> {
    const existing = await this.repos.qrCodes.findActiveForBranch(branchId, businessId);
    if (existing) {
      await this.repos.qrCodes.revoke(existing.id, businessId, actorId);
    }

    const qrCode = await this.repos.qrCodes.create({ businessId, branchId, createdBy: actorId });
    return this.issue(qrCode);
  }

  private async issue(qrCode: QrCode): Promise<IssuedQrCode> {
    const token = await signQrToken(
      { qrCodeId: qrCode.id, businessId: qrCode.businessId, branchId: qrCode.branchId },
      this.secrets.QR_TOKEN_SECRET,
    );
    return { qrCode, token };
  }

  /**
   * Public entry point: resolves an anonymous signed token to its QR code
   * row. Verifies the signature/claims first (qr/qr-token.ts), THEN looks
   * up the row by the now-trusted `sub` -- never the reverse, per S5.2's
   * "never treat unsigned identifiers as proof of eligibility." Malformed,
   * expired, wrong-signature, and revoked/unknown tokens all produce the
   * identical 404 -- enumeration resistance, same principle as login's
   * identical error for a wrong password vs. a nonexistent account.
   */
  async resolveToken(token: string): Promise<QrCode> {
    let payload: QrTokenPayload;
    try {
      payload = await verifyQrToken(token, this.secrets.QR_TOKEN_SECRET, this.secrets.QR_TOKEN_SECRET_PREVIOUS);
    } catch {
      // Cryptographically unverifiable -- malformed, expired, wrong secret,
      // or wrong `type`. No trustworthy businessId/branchId exists to
      // attribute a fraud_signals row to here: decoding the payload
      // without verifying its signature first would mean writing
      // attacker-chosen values into a NOT NULL, tenant-scoping FK (any
      // base64url payload decodes without a secret). Same "not every
      // rejection needs a persisted row" acceptance already documented for
      // failed auth attempts (security-review.md) -- Workers' own request
      // logs still capture this rejection.
      throw new AppError('This QR code is no longer valid.', 404, 'QR_CODE_NOT_FOUND');
    }

    const qrCode = await this.repos.qrCodes.findActiveById(payload.sub);
    // payload.branchId/businessId are redundant with the row's own columns
    // today -- sub is that row's id, and a row's business/branch never
    // change after creation -- checked anyway as defense in depth, same
    // principle verifyAccessToken applies to its `type` claim: cheap, and
    // it's there for the mistake nobody's made yet.
    if (!qrCode || qrCode.businessId !== payload.businessId || qrCode.branchId !== payload.branchId) {
      await this.recordRejection(payload);
      throw new AppError('This QR code is no longer valid.', 404, 'QR_CODE_NOT_FOUND');
    }
    return qrCode;
  }

  /**
   * Only reachable once a token has verified cryptographically, so
   * businessId/branchId here are genuinely trustworthy -- a correctly
   * signed token whose row is gone, revoked, or branch-mismatched (S5.2's
   * "revoked" rejection class). Best-effort: a failure here must never
   * mask the 404 the caller is about to throw regardless, and must never
   * be the reason a legitimate rejection goes unreported to the customer.
   */
  private async recordRejection(payload: QrTokenPayload): Promise<void> {
    try {
      await this.repos.fraudSignals.create({
        businessId: payload.businessId,
        branchId: payload.branchId,
        signalType: 'qr_token',
        reasonCode: 'revoked_or_unknown',
        metadata: { qrCodeId: payload.sub, tokenIssuedAt: payload.iat },
      });
    } catch {
      // Swallow -- see doc comment above.
      return;
    }
  }
}
