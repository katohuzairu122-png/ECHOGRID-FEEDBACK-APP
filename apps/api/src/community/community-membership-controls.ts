import type { Db } from '../db/client';
import { AppError } from '../lib/errors';

export const COMMUNITY_MEMBERSHIP_CONTROL_KEYS = {
  join: 'COMMUNITY_MEMBERSHIP_JOIN_ENABLED',
  rejoin: 'COMMUNITY_MEMBERSHIP_REJOIN_ENABLED',
  restore: 'COMMUNITY_MEMBERSHIP_RESTORE_ENABLED',
  clearance: 'COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED',
} as const;
export type CommunityMembershipOperation = keyof typeof COMMUNITY_MEMBERSHIP_CONTROL_KEYS;
export type CommunityMembershipControlConfig = Partial<Record<(typeof COMMUNITY_MEMBERSHIP_CONTROL_KEYS)[CommunityMembershipOperation], unknown>>;
type ControlState = 'enabled' | 'disabled' | 'invalid';
type SignalOperation = CommunityMembershipOperation | 'activation';
type SignalReason = 'permitted' | 'disabled' | 'invalid_configuration' | 'missing_permit' | 'transition_failed';
const emitted = new Set<string>();

/** Bounded, identifier-free diagnostics: at most one event per operation/reason
 * per isolate. Never consent evidence, request logs or activity counters.
 * A broken log sink cannot change a transaction or authorization decision. */
export function recordCommunityMembershipControl(operation: SignalOperation, reason: SignalReason): void {
  const key = operation + ':' + reason;
  if (emitted.has(key)) return;
  emitted.add(key);
  try {
    console.info(JSON.stringify({ event: 'community_membership.control', operation, reason }));
  } catch { /* Diagnostics must never affect application behavior. */ }
}

const permitBrand: unique symbol = Symbol('community-membership-write');
export type CommunityMembershipWritePermit = { readonly [permitBrand]: true };
const permits = new WeakMap<CommunityMembershipWritePermit, { db: Db; customerId: string; operation: CommunityMembershipOperation }>();

function disabled(): never {
  throw new AppError('Community membership is temporarily unavailable. Please try again later.', 503, 'COMMUNITY_MEMBERSHIP_OPERATION_DISABLED');
}

/** Immutable request/service-instance snapshot. Only the exact string "true"
 * enables an operation. No global/process env, client fields or Feed flag.
 * A new Worker revision does not cancel an already-authorized transaction. */
export class CommunityMembershipControls {
  private readonly states: Readonly<Record<CommunityMembershipOperation, ControlState>>;
  constructor(config: CommunityMembershipControlConfig = {}) {
    const state = (operation: CommunityMembershipOperation): ControlState => {
      const value = config[COMMUNITY_MEMBERSHIP_CONTROL_KEYS[operation]];
      return value === 'true' ? 'enabled' : value === undefined || value === 'false' ? 'disabled' : 'invalid';
    };
    this.states = Object.freeze({ join: state('join'), rejoin: state('rejoin'), restore: state('restore'), clearance: state('clearance') });
  }
  available(operation: CommunityMembershipOperation): boolean {
    return this.states[operation] === 'enabled';
  }
  authorize(db: Db, customerId: string, operation: CommunityMembershipOperation): CommunityMembershipWritePermit {
    if (!this.available(operation)) {
      recordCommunityMembershipControl(operation, this.states[operation] === 'invalid' ? 'invalid_configuration' : 'disabled');
      disabled();
    }
    const permit = Object.freeze({ [permitBrand]: true as const });
    permits.set(permit, { db, customerId, operation });
    return permit;
  }
}

/** Defense in depth for all repository callers, including omitted-status
 * inserts. Permits are opaque, nonserializable and bound to this DB/transaction
 * object, customer and target operation. Raw SQL/privileged DB access remains
 * outside this application control; no new database authority is introduced. */
export function assertCommunityMembershipWrite(
  db: Db, customerId: string, status: string | undefined, permit?: CommunityMembershipWritePermit,
): void {
  if (status !== 'active' && status !== 'inactive') return;
  const authority = permit && permits.get(permit);
  if (!authority || authority.db !== db || authority.customerId !== customerId ||
      (status === 'inactive' ? authority.operation !== 'clearance' : authority.operation === 'clearance')) {
    recordCommunityMembershipControl(status === 'inactive' ? 'clearance' : 'activation', 'missing_permit');
    disabled();
  }
}

/** A permitted initial Join cannot be borrowed for Rejoin/Restore or clearance. */
export function assertCommunityMembershipOperation(permit: CommunityMembershipWritePermit | undefined, operation: CommunityMembershipOperation | null): void {
  if (!permit || !operation || permits.get(permit)?.operation !== operation) {
    recordCommunityMembershipControl('activation', 'missing_permit');
    disabled();
  }
}
