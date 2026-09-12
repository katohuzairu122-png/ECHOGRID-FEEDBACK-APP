import { AppError } from '../lib/errors';

/**
 * Whether a business is in a state that may serve staff requests at all.
 *
 * Separated from resolveTenantContext, which stays plumbing (read headers,
 * open a connection, attach context), so the policy is a pure function with
 * its own tests. Same split the fraud detectors already use: mechanics in
 * one module, the judgment about what they mean in another.
 *
 * WHY THIS EXISTS
 * `businesses.status` has admitted 'active' | 'suspended' | 'archived' since
 * the table was created, and `PATCH /platform/businesses/:id/status` --
 * admin-only, audited, and described in its own comment as the ability to
 * "take a paying customer's business offline" -- wrote it. Nothing ever read
 * it in the request path. resolveTenantContext checked membership and
 * stopped, so a suspended business kept full read and write API access.
 *
 * An audited, permission-gated control with no effect is worse than an
 * absent one: the audit log records that the business was suspended, so
 * nobody goes looking for why it is still serving traffic.
 */

/** The only status that may serve staff requests. */
export const ACTIVE_BUSINESS_STATUS = 'active';

/**
 * Throws unless the business exists and is active.
 *
 * `undefined` means BusinessRepository.findById filtered it out, which it
 * does for soft-deleted rows -- so a deleted business lands here too, and
 * deleted is definitively not active. Deliberately collapsed into the same
 * error as suspended/archived rather than a distinct "not found": by the
 * time this runs, membership has already been confirmed, so there is no
 * information to protect and no reason to give three different answers to a
 * member who cannot proceed either way.
 *
 * 403, not 404 or 423: the caller is authenticated and is a member: they are
 * being refused, not told the thing is missing. And the message names the
 * remedy, because the only remedy is a platform admin reactivating it --
 * nothing the caller can do by retrying or fixing their request.
 *
 * MUST run AFTER the membership check, never before. Calling it first would
 * let any authenticated user distinguish "business exists but is suspended"
 * from "no such business" for an id they have no relationship with.
 */
export function assertBusinessIsUsable(business: { status: string } | undefined): void {
  if (!business || business.status !== ACTIVE_BUSINESS_STATUS) {
    throw new AppError(
      'This business is not currently active. Contact support to restore access.',
      403,
      'BUSINESS_NOT_ACTIVE',
    );
  }
}
