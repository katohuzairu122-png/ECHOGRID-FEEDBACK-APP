import { describe, it, expect } from 'vitest';
import { assertBusinessIsUsable, ACTIVE_BUSINESS_STATUS } from './business-access';
import { AppError } from '../lib/errors';

/**
 * The status gate that resolveTenantContext was missing. Every case here
 * passed before this function existed, because nothing read
 * `businesses.status` in the request path at all.
 *
 * The three rejecting cases are each a distinct real state: a platform admin
 * suspended the business, wound it down, or soft-deleted it (which reaches
 * this function as `undefined`, since BusinessRepository.findById filters
 * deleted rows out).
 */
describe('assertBusinessIsUsable', () => {
  it('allows an active business', () => {
    expect(() => assertBusinessIsUsable({ status: ACTIVE_BUSINESS_STATUS })).not.toThrow();
  });

  it('rejects a suspended business', () => {
    expect(() => assertBusinessIsUsable({ status: 'suspended' })).toThrow(AppError);
  });

  it('rejects an archived business', () => {
    expect(() => assertBusinessIsUsable({ status: 'archived' })).toThrow(AppError);
  });

  it('rejects undefined -- a soft-deleted business is filtered out by findById', () => {
    expect(() => assertBusinessIsUsable(undefined)).toThrow(AppError);
  });

  it('rejects any status the CHECK constraint may admit later, rather than allow-listing failures', () => {
    // Allow-listing the ACTIVE value instead of deny-listing the inactive
    // ones is the load-bearing choice: a fourth status added to
    // businesses_status_check in future is refused by default rather than
    // silently granted access because nobody updated a deny-list.
    expect(() => assertBusinessIsUsable({ status: 'pending_verification' })).toThrow(AppError);
    expect(() => assertBusinessIsUsable({ status: '' })).toThrow(AppError);
  });

  it('answers 403 with one code for every rejecting case -- a member learns nothing from which', () => {
    for (const business of [
      { status: 'suspended' },
      { status: 'archived' },
      undefined,
    ] as ({ status: string } | undefined)[]) {
      let thrown: unknown;
      try {
        assertBusinessIsUsable(business);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(AppError);
      const appError = thrown as AppError;
      // 403 not 404: the caller is an authenticated member being refused,
      // not someone being told the business does not exist.
      expect(appError.status).toBe(403);
      expect(appError.code).toBe('BUSINESS_NOT_ACTIVE');
    }
  });
});
