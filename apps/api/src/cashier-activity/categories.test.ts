import { describe, expect, it } from 'vitest';
import { ACTION, categorize, cashierRequestAudit, filterFor, safeReference, CASHIER_CATEGORIES } from './categories';

const marked = (extra: Record<string, unknown> = {}) => ({ client: 'cashier', ...extra });

describe('cashier activity categorisation', () => {
  it('maps each required category from existing audit actions', () => {
    expect(categorize(ACTION.lookupHit, marked())).toEqual({ categories: ['customer_lookup'], outcome: 'success' });
    expect(categorize(ACTION.lookupMiss, marked())).toEqual({ categories: ['customer_lookup'], outcome: 'failure' });
    expect(categorize(ACTION.qrVerified, marked())?.categories).toEqual(['qr_verification']);
    expect(categorize(ACTION.qrRejected, marked())?.outcome).toBe('failure');
    expect(categorize(ACTION.purchase, marked())?.categories).toEqual(['points_issued']);
    expect(categorize(ACTION.purchaseViaLookup, marked())?.categories).toEqual(['points_issued']);
    expect(categorize(ACTION.redemptionConfirmed, marked())?.categories).toEqual(['redemption_attempt', 'redemption_success']);
    expect(categorize(ACTION.redemptionRejected, marked())?.categories).toEqual(['redemption_attempt', 'redemption_failure']);
    expect(categorize(ACTION.redemptionLookup, marked({ outcome: 'success' }))?.categories).toEqual(['redemption_attempt']);
    expect(categorize(ACTION.redemptionLookup, marked({ outcome: 'failure' }))?.categories).toEqual(['redemption_attempt', 'redemption_failure']);
    expect(categorize(ACTION.authzFailed, marked())?.categories).toEqual(['security']);
  });

  it('session actions are history by action alone', () => {
    for (const a of [ACTION.sessionRevoked, ACTION.sessionRevokedAll, ACTION.cashierLogin, ACTION.cashierLogout])
      expect(categorize(a, null)?.categories).toEqual(['session']);
  });

  it('unmarked (staff or pre-existing) rows are not cashier activity', () => {
    for (const a of [ACTION.purchase, ACTION.redemptionConfirmed, ACTION.lookupHit, ACTION.authFailed])
      expect(categorize(a, null)).toBeNull();
    expect(categorize(ACTION.purchase, { client: 'web' })).toBeNull();
    expect(categorize('loyalty.points_adjusted', marked())).toBeNull();
    expect(categorize('team.invite', null)).toBeNull();
  });

  it('every category has a stored-row selection', () => {
    for (const c of CASHIER_CATEGORIES) expect(filterFor(c).length).toBeGreaterThan(0);
  });

  it('exposes only non-personal references', () => {
    expect(safeReference('loyalty_transaction', 'tx')).toBe('tx');
    expect(safeReference('session', 's')).toBe('s');
    for (const t of ['customer_lookup', 'loyalty_account', 'unknown']) expect(safeReference(t, 'x')).toBeNull();
    expect(safeReference('session', null)).toBeNull();
  });
});

describe('rows produced for cashier requests that would otherwise leave none', () => {
  it('QR verification, redemption lookups and rejected confirmations', () => {
    expect(cashierRequestAudit('POST', '/loyalty/actions/resolve-customer', 200)?.action).toBe(ACTION.qrVerified);
    expect(cashierRequestAudit('POST', '/loyalty/actions/resolve-customer', 404)?.action).toBe(ACTION.qrRejected);
    expect(cashierRequestAudit('GET', '/loyalty/redemptions/ABC', 200)?.action).toBe(ACTION.redemptionLookup);
    expect(cashierRequestAudit('GET', '/loyalty/redemptions/ABC', 404)?.action).toBe(ACTION.redemptionLookup);
    expect(cashierRequestAudit('POST', '/loyalty/redemptions/ABC/confirm', 409)?.action).toBe(ACTION.redemptionRejected);
  });
  it('leaves successful purchases and confirmations to their own semantic rows, and everything else alone', () => {
    expect(cashierRequestAudit('POST', '/loyalty/redemptions/ABC/confirm', 200)).toBeNull();
    expect(cashierRequestAudit('POST', '/loyalty/accounts/x/purchase', 200)).toBeNull();
    expect(cashierRequestAudit('POST', '/loyalty/actions/lookup-customer', 200)).toBeNull();
    expect(cashierRequestAudit('GET', '/auth/me', 200)).toBeNull();
  });
});

describe('SEC-CASHIER-R2 F9 audit coverage', () => {
  it('records rejected purchases (both routes) as failures in points_issued, and the selection step as a session row', () => {
    expect(cashierRequestAudit('POST', '/loyalty/accounts/x/purchase', 422)?.action).toBe(ACTION.purchase);
    expect(cashierRequestAudit('POST', '/loyalty/actions/lookup-purchase', 409)?.action).toBe(ACTION.purchaseViaLookup);
    expect(categorize(ACTION.purchase, marked({ outcome: 'failure' }))).toEqual({ categories: ['points_issued'], outcome: 'failure' });
    expect(categorize(ACTION.cashierSelectionRequired, null)?.categories).toEqual(['session']);
  });
});
