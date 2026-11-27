import { toMilli } from '../money-storage';

/**
 * LPC-12/13: the enforcement boundaries a promotional overlay must pass, as PURE, policy-neutral checks. Nothing here awards anything, reads a
 * database or chooses between overlays. It exists so that, once the Owner approves a stacking and award-selection policy, the award path has
 * tested building blocks, and so that until then every path FAILS CLOSED: no overlay is ever treated as compatible, stackable, exclusive or
 * preferred by default.
 *
 * Deliberately NOT decided here (Owner decisions): whether overlays may stack, how a winner is chosen among several eligible overlays, what the
 * customer caps and budgets are, and whether an overlay applies on top of or instead of a programme's own earning.
 */
export type OverlayRefusal =
  | 'POLICY_UNAPPROVED'
  | 'TENANT_MISMATCH'
  | 'NOT_YET_ACTIVE'
  | 'EXPIRED'
  | 'DUPLICATE_AWARD'
  | 'CUSTOMER_CAP_REACHED'
  | 'BUDGET_EXHAUSTED'
  | 'COMPATIBILITY_UNDEFINED'
  | 'INCOMPATIBLE';

export interface OverlayPolicy {
  /** Policy version recorded on every decision, so an award can always be traced to the rules in force. */
  version: number;
  /** An unapproved policy refuses everything. Only an Owner decision may set this to 'approved'. */
  status: 'unapproved' | 'approved';
  /** Which overlay kinds may be awarded together. Absent means UNDEFINED, never "all allowed" and never "none allowed". */
  compatibility?: ReadonlyArray<readonly [string, string]> | undefined;
}

export interface OverlayCandidate {
  id: string;
  kind: string;
  businessId: string;
  startsAt: Date;
  endsAt: Date | null;
  /** Per-customer cap within the overlay's own period; null = the overlay states none (an Owner decision, never defaulted here). */
  customerCap: number | null;
  /** Campaign budget and spend so far, exact decimal text in the business currency; null budget = none stated. */
  budget: string | null;
  spent: string;
  /** The value this award would add to spend, exact decimal text. */
  awardValue: string;
  /** Deterministic key of the award (overlay, customer and the thing that triggered it): a replay of it is a duplicate. */
  awardKey: string;
}

export interface OverlayContext {
  businessId: string;
  now: Date;
  /** Awards this customer already received from THIS overlay in its period. */
  customerAwardsInPeriod: number;
  existingAwardKeys: ReadonlySet<string>;
}

export type OverlayDecision =
  | { ok: true; policyVersion: number }
  | { ok: false; reason: OverlayRefusal; policyVersion: number };

/** The first boundary an overlay fails, in a fixed order; otherwise eligible. Never selects, ranks or stacks. */
export function checkOverlay(policy: OverlayPolicy, overlay: OverlayCandidate, context: OverlayContext): OverlayDecision {
  const refuse = (reason: OverlayRefusal): OverlayDecision => ({ ok: false, reason, policyVersion: policy.version });
  if (policy.status !== 'approved') return refuse('POLICY_UNAPPROVED');
  if (overlay.businessId !== context.businessId) return refuse('TENANT_MISMATCH');
  if (context.now < overlay.startsAt) return refuse('NOT_YET_ACTIVE');
  if (overlay.endsAt !== null && context.now >= overlay.endsAt) return refuse('EXPIRED');
  if (context.existingAwardKeys.has(overlay.awardKey)) return refuse('DUPLICATE_AWARD');
  if (overlay.customerCap !== null && context.customerAwardsInPeriod >= overlay.customerCap) return refuse('CUSTOMER_CAP_REACHED');
  if (overlay.budget !== null && toMilli(overlay.spent) + toMilli(overlay.awardValue) > toMilli(overlay.budget)) return refuse('BUDGET_EXHAUSTED');
  return { ok: true, policyVersion: policy.version };
}

/**
 * Whether two overlays that are each eligible may both be awarded. With no approved compatibility matrix the answer is a refusal to decide
 * ('COMPATIBILITY_UNDEFINED'), so nothing can stack by accident or be silently excluded; a listed pair is compatible, an unlisted pair is not.
 */
export function checkCompatibility(policy: OverlayPolicy, a: OverlayCandidate, b: OverlayCandidate): OverlayDecision {
  const refuse = (reason: OverlayRefusal): OverlayDecision => ({ ok: false, reason, policyVersion: policy.version });
  if (policy.status !== 'approved') return refuse('POLICY_UNAPPROVED');
  if (a.businessId !== b.businessId) return refuse('TENANT_MISMATCH');
  if (!policy.compatibility) return refuse('COMPATIBILITY_UNDEFINED');
  const listed = policy.compatibility.some(([x, y]) => (x === a.kind && y === b.kind) || (x === b.kind && y === a.kind));
  return listed ? { ok: true, policyVersion: policy.version } : refuse('INCOMPATIBLE');
}

/**
 * Every eligible overlay and every refusal, in input order. It does NOT pick a winner: an award-selection policy is an Owner decision, so the
 * caller must supply an approved selector in a later block. `selection` says so explicitly rather than implying a default.
 */
export function evaluateOverlays(policy: OverlayPolicy, overlays: readonly OverlayCandidate[], context: OverlayContext): {
  eligible: OverlayCandidate[];
  refused: { overlay: OverlayCandidate; reason: OverlayRefusal }[];
  selection: 'UNDECIDED';
  policyVersion: number;
} {
  const eligible: OverlayCandidate[] = [];
  const refused: { overlay: OverlayCandidate; reason: OverlayRefusal }[] = [];
  for (const overlay of overlays) {
    const decision = checkOverlay(policy, overlay, context);
    if (decision.ok) eligible.push(overlay);
    else refused.push({ overlay, reason: decision.reason });
  }
  return { eligible, refused, selection: 'UNDECIDED', policyVersion: policy.version };
}
