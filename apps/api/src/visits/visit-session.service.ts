import type { Repositories } from '../repositories';
import type { VisitSession } from '../repositories/visit-session.repository';
import type { VisitVerificationProvider, VisitVerificationResult } from './visit-verification';
import { generateVisitSessionCode } from './visit-session-code';

/**
 * Owns the full lifecycle of a staff-issued visit_sessions row -- issue,
 * verify/consume, revoke -- the same single-class shape qr-code.service.ts
 * uses for qr_codes (issue + resolve together), not a separate "issuer"
 * class and "verifier" class for what is, underneath, one table's lifecycle.
 * Implements VisitVerificationProvider directly rather than composing a
 * standalone wrapper around it, for the same reason: nothing today needs to
 * hold a VisitVerificationProvider reference without also being able to
 * issue/revoke through the concrete class, so a second class would be
 * indirection with no current caller.
 *
 * No route wires this up yet (Continuing Development Block 4.2 explicitly
 * excludes route wiring -- that's Block 4.3). This class alone is fully
 * self-contained and independently unit-testable in the meantime.
 */
export class VisitSessionService implements VisitVerificationProvider {
  readonly type = 'staff_issued_session';

  constructor(private readonly repos: Pick<Repositories, 'visitSessions'>) {}

  /**
   * `maxUses` omitted or null issues a TABLE SESSION (unlimited uses until
   * expiresAt); a positive integer issues a ONE-TIME-OR-N-TIME VISIT TOKEN
   * -- see visit-sessions.ts's schema doc comment for why this is one
   * method, not two. `ttlSeconds` has no default: a table session's
   * lifetime (hours, one service window) and a one-time token's (minutes,
   * handed to one customer) are different enough in kind that a shared
   * default would be right for neither -- the caller always states it.
   *
   * No collision-retry loop around the partial-unique-index insert --
   * qr-code.service.ts's regenerate() documents accepting the same
   * check-then-write race on its own branch/code uniqueness rather than
   * retrying around it, and that reasoning applies at least as well here:
   * a collision requires two still-ACTIVE sessions at the same branch to
   * independently roll the identical 6-character code inside their shared
   * (typically minutes-to-hours) window, astronomically rarer than the QR
   * case this codebase already accepts without a retry.
   */
  async issue(
    businessId: string,
    branchId: string,
    createdBy: string,
    options: { ttlSeconds: number; maxUses?: number | null },
  ): Promise<VisitSession> {
    return this.repos.visitSessions.create({
      businessId,
      branchId,
      code: generateVisitSessionCode(),
      expiresAt: new Date(Date.now() + options.ttlSeconds * 1000),
      maxUses: options.maxUses ?? null,
      createdBy,
    });
  }

  /**
   * The VisitVerificationProvider entry point. `proof` is the code the
   * customer typed. Every rejection path -- not found, wrong business,
   * expired, exhausted, revoked, or raced by a concurrent use -- returns
   * the identical `invalid_or_expired` reasonCode, the same enumeration-
   * resistance principle qr-code.service.ts's resolveToken applies to QR
   * tokens: nothing here lets a caller distinguish "doesn't exist" from
   * "exists but is dead."
   */
  async verify(businessId: string, branchId: string, proof: string): Promise<VisitVerificationResult> {
    const session = await this.repos.visitSessions.findActiveByCode(branchId, proof);

    // businessId is checked before recordUse and does NOT consume a use.
    // findActiveByCode is already branchId-scoped, and a branch belongs to
    // exactly one business, so a session found under the right branchId
    // already has the right businessId in every reachable case -- this is
    // defense in depth only, the same redundant check resolveToken makes
    // against its own verified payload, cheap insurance against a mistake
    // nobody's made yet rather than a path this code expects to hit.
    if (!session || session.businessId !== businessId) {
      return { verified: false, reasonCode: 'invalid_or_expired' };
    }

    const used = await this.repos.visitSessions.recordUse(session.id);
    if (!used) {
      // Expired, exhausted, revoked, or raced by a concurrent use between
      // the read above and this atomic UPDATE -- recordUse's own doc
      // comment covers why none of those are distinguishable from here, by
      // design.
      return { verified: false, reasonCode: 'invalid_or_expired' };
    }

    return {
      verified: true,
      metadata: { sessionId: used.id, useCount: used.useCount, maxUses: used.maxUses },
    };
  }

  /**
   * Public, unlike qr-code.service.ts's revoke step (private there, only
   * ever called as part of regenerate()'s issue-a-replacement flow). A
   * visit session has a real standalone cancellation case with no paired
   * reissue -- a table session created by mistake, a one-time code that
   * leaked to the wrong person -- so this stays a first-class public
   * operation rather than folded into another method.
   */
  async revoke(id: string, businessId: string, revokedBy: string): Promise<void> {
    await this.repos.visitSessions.revoke(id, businessId, revokedBy);
  }
}
