/**
 * CASHIER-PWA-01 C7: how existing audit rows map to cashier activity categories. Pure and database-free.
 *
 * No new persistence: history is a read-only view over `audit_log`. Rows count as cashier activity when they were
 * recorded for a cashier-scoped token (`metadata.client = 'cashier'`, added by the audit middleware and the lookup
 * service) or are one of the cashier session actions below. Rows written before this change carry no cashier marker
 * and are not part of the history (no backfill).
 */
export const CASHIER_CATEGORIES = [
  'customer_lookup',
  'qr_verification',
  'points_issued',
  'redemption_attempt',
  'redemption_success',
  'redemption_failure',
  'session',
  'security',
] as const;
export type CashierCategory = (typeof CASHIER_CATEGORIES)[number];

export const ACTION = {
  lookupHit: 'loyalty.customer_lookup',
  lookupMiss: 'loyalty.customer_lookup_miss',
  qrVerified: 'cashier.qr_verified',
  qrRejected: 'cashier.qr_rejected',
  purchase: 'loyalty.purchase_recorded',
  purchaseViaLookup: 'loyalty.purchase_recorded_via_lookup',
  redemptionLookup: 'cashier.redemption_lookup',
  redemptionConfirmed: 'loyalty.redemption_confirmed',
  redemptionRejected: 'cashier.redemption_rejected',
  sessionRevoked: 'cashier_session.revoked',
  sessionRevokedAll: 'cashier_session.revoked_all',
  cashierLogin: 'auth.cashier_login',
  cashierLogout: 'auth.cashier_logout',
  authFailed: 'security.authentication_failed',
  authzFailed: 'security.authorization_failed',
} as const;

/** Session actions are history by action alone: they are recorded by staff routes or the cashier auth routes. */
export const SESSION_ACTIONS: readonly string[] = [
  ACTION.sessionRevoked,
  ACTION.sessionRevokedAll,
  ACTION.cashierLogin,
  ACTION.cashierLogout,
];

/** Actions that count as cashier activity only when the row carries the cashier marker. */
export const MARKED_ACTIONS: readonly string[] = [
  ACTION.lookupHit,
  ACTION.lookupMiss,
  ACTION.qrVerified,
  ACTION.qrRejected,
  ACTION.purchase,
  ACTION.purchaseViaLookup,
  ACTION.redemptionLookup,
  ACTION.redemptionConfirmed,
  ACTION.redemptionRejected,
  ACTION.authFailed,
  ACTION.authzFailed,
];

export type Outcome = 'success' | 'failure';

/** Category (and outcome) of one stored row, or null when the row is not cashier activity. */
export function categorize(
  action: string,
  metadata: Record<string, unknown> | null,
): { categories: CashierCategory[]; outcome: Outcome } | null {
  const marked = metadata?.client === 'cashier';
  const stated = metadata?.outcome === 'failure' ? 'failure' : metadata?.outcome === 'success' ? 'success' : null;
  if (SESSION_ACTIONS.includes(action)) return { categories: ['session'], outcome: stated ?? 'success' };
  if (!marked || !MARKED_ACTIONS.includes(action)) return null;
  switch (action) {
    case ACTION.lookupHit:
      return { categories: ['customer_lookup'], outcome: 'success' };
    case ACTION.lookupMiss:
      return { categories: ['customer_lookup'], outcome: 'failure' };
    case ACTION.qrVerified:
      return { categories: ['qr_verification'], outcome: 'success' };
    case ACTION.qrRejected:
      return { categories: ['qr_verification'], outcome: 'failure' };
    case ACTION.purchase:
    case ACTION.purchaseViaLookup:
      return { categories: ['points_issued'], outcome: stated ?? 'success' };
    case ACTION.redemptionLookup:
      return {
        categories: stated === 'failure' ? ['redemption_attempt', 'redemption_failure'] : ['redemption_attempt'],
        outcome: stated ?? 'success',
      };
    case ACTION.redemptionConfirmed:
      return { categories: ['redemption_attempt', 'redemption_success'], outcome: 'success' };
    case ACTION.redemptionRejected:
      return { categories: ['redemption_attempt', 'redemption_failure'], outcome: 'failure' };
    default:
      return { categories: ['security'], outcome: 'failure' };
  }
}

export interface ActivityFilter {
  /** Stored action names this category selects, with an optional required outcome (read from metadata). */
  actions: readonly string[];
  outcome?: Outcome;
}

/** The stored-row selection behind each category filter. */
export function filterFor(category: CashierCategory): ActivityFilter[] {
  switch (category) {
    case 'customer_lookup':
      return [{ actions: [ACTION.lookupHit, ACTION.lookupMiss] }];
    case 'qr_verification':
      return [{ actions: [ACTION.qrVerified, ACTION.qrRejected] }];
    case 'points_issued':
      return [{ actions: [ACTION.purchase, ACTION.purchaseViaLookup] }];
    case 'redemption_attempt':
      return [{ actions: [ACTION.redemptionLookup, ACTION.redemptionConfirmed, ACTION.redemptionRejected] }];
    case 'redemption_success':
      return [{ actions: [ACTION.redemptionConfirmed] }];
    case 'redemption_failure':
      return [{ actions: [ACTION.redemptionRejected] }, { actions: [ACTION.redemptionLookup], outcome: 'failure' }];
    case 'session':
      return [{ actions: SESSION_ACTIONS }];
    case 'security':
      return [{ actions: [ACTION.authFailed, ACTION.authzFailed] }];
  }
}

/** Entity types whose id is a safe, non-personal reference. Customer and account ids are never exposed. */
const SAFE_REFERENCE_TYPES = new Set(['loyalty_transaction', 'session']);
export const safeReference = (entityType: string, entityId: string | null): string | null =>
  entityId && SAFE_REFERENCE_TYPES.has(entityType) ? entityId : null;

/**
 * Which audit row a cashier request outside the generic path should produce. Used by the audit middleware for the
 * requests that otherwise leave no row (reads, rejections, QR verification). Success of a purchase or a confirmed
 * redemption is NOT here: the handler's own semantic row is decorated instead.
 */
export function cashierRequestAudit(
  method: string,
  apiPath: string,
  status: number,
): { action: string; entityType: string } | null {
  const failed = status >= 400;
  if (method === 'POST' && apiPath === '/loyalty/actions/resolve-customer')
    return { action: failed ? ACTION.qrRejected : ACTION.qrVerified, entityType: 'qr_verification' };
  if (method === 'GET' && /^\/loyalty\/redemptions\/[^/]+$/.test(apiPath))
    return { action: ACTION.redemptionLookup, entityType: 'redemption' };
  if (failed && method === 'POST' && /^\/loyalty\/redemptions\/[^/]+\/confirm$/.test(apiPath))
    return { action: ACTION.redemptionRejected, entityType: 'redemption' };
  return null;
}
