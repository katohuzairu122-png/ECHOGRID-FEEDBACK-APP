/**
 * Split 07 / HETA-01D logical assessment of a historical subscription-state certificate for ONE scoped identity and ONE window W = [from, to).
 *
 * PURE and NON-ACTIVATING. It evaluates a caller-supplied proof bundle and interval partition against the HETA-01D rules and returns a logical
 * assessment state. Even `certified` is a logical proof result only: `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` are the
 * literal `false` in every outcome, there is no caller-supplied "verified" value, and nothing here reads a database or provider. A positive result
 * needs a documented SOURCE COMPLETENESS GUARANTEE (`completenessGuaranteeRef`) that no provider transition was omitted; this deployment has not
 * established one (HETA-01D section 5), so production inputs cannot honestly reach `certified`. Fixtures supply it in tests only.
 *
 * Aggregate precedence (HETA-01D section 7): conflicted, then incomplete, then unproven; certified requires no defect. Invalid input is rejected
 * before any trusted assessment. Gaps are explicit missing coverage and are never filled by the nearest observation.
 */
export type AssessmentState = 'certified' | 'incomplete' | 'conflicted' | 'unproven';
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'canceled' | 'unpaid' | 'incomplete' | 'incomplete_expired';

export interface ScopedIdentity {
  providerAccountId: string;
  livemode: boolean;
  businessId: string;
  bindingRevision: number;
  customerId: string;
  subscriptionId: string;
}

export interface StateInterval {
  /** Half-open [effectiveFrom, effectiveTo), epoch milliseconds, finite. */
  effectiveFrom: number;
  effectiveTo: number;
  identity: ScopedIdentity;
  state: { priceId: string; planKey: string | null; status: SubscriptionStatus; currency: string; interval: 'month' | 'year'; itemCount: number };
  /** `proved` only for an independently executed boundary under a validated provider rule; request/event/period times are not proof. */
  fromBoundary: 'proved' | 'uncertain';
  toBoundary: 'proved' | 'uncertain';
  mappingRevision: string;
  sourceRefs: readonly string[];
}

export interface CoverageAttestation { sourceId: string; from: number; to: number; attested: boolean }

export interface ProofBundle {
  ruleVersion: string;
  /** Verified subscription inception: the chain must be proved from here (an arbitrary later checkpoint cannot erase prior history). */
  inceptionAt: number;
  initialStateVerified: boolean;
  mutationPathInventoryComplete: boolean;
  coverage: readonly CoverageAttestation[];
  manifest: { cutoff: number; truncated: boolean; errorCount: number; retentionGapRanges: number } | null;
  manifestIntegrityVerified: boolean;
  catalogMappingVerified: boolean;
  /** Reference to the documented source completeness guarantee. `null` = none established. */
  completenessGuaranteeRef: string | null;
  /** References to unresolved conflicting authenticated claims. */
  unresolvedConflictRefs: readonly string[];
}

export type FindingCode =
  | 'IDENTITY_MISMATCH' | 'INTERVAL_OVERLAP' | 'UNRESOLVED_CONFLICT'
  | 'COVERAGE_GAP' | 'ATTESTATION_GAP' | 'NO_MANIFEST' | 'MANIFEST_TRUNCATED' | 'MANIFEST_ERRORS' | 'MANIFEST_CUTOFF_BEFORE_WINDOW_END' | 'RETENTION_GAP'
  | 'UNCERTAIN_BOUNDARY' | 'INITIAL_STATE_UNPROVEN' | 'MUTATION_PATH_INVENTORY_INCOMPLETE' | 'NO_SOURCE_COMPLETENESS_GUARANTEE' | 'MANIFEST_INTEGRITY_UNVERIFIED'
  | 'CATALOG_MAPPING_UNVERIFIED' | 'UNMAPPED_PRICE' | 'UNSUPPORTED_ITEM_COUNT' | 'UNSUPPORTED_INTERVAL' | 'UNSUPPORTED_CURRENCY' | 'UNSUPPORTED_STATUS';

const CLASS: Record<FindingCode, Exclude<AssessmentState, 'certified'>> = {
  IDENTITY_MISMATCH: 'conflicted', INTERVAL_OVERLAP: 'conflicted', UNRESOLVED_CONFLICT: 'conflicted',
  COVERAGE_GAP: 'incomplete', ATTESTATION_GAP: 'incomplete', NO_MANIFEST: 'incomplete', MANIFEST_TRUNCATED: 'incomplete', MANIFEST_ERRORS: 'incomplete',
  MANIFEST_CUTOFF_BEFORE_WINDOW_END: 'incomplete', RETENTION_GAP: 'incomplete',
  UNCERTAIN_BOUNDARY: 'unproven', INITIAL_STATE_UNPROVEN: 'unproven', MUTATION_PATH_INVENTORY_INCOMPLETE: 'unproven', NO_SOURCE_COMPLETENESS_GUARANTEE: 'unproven',
  MANIFEST_INTEGRITY_UNVERIFIED: 'unproven', CATALOG_MAPPING_UNVERIFIED: 'unproven', UNMAPPED_PRICE: 'unproven', UNSUPPORTED_ITEM_COUNT: 'unproven',
  UNSUPPORTED_INTERVAL: 'unproven', UNSUPPORTED_CURRENCY: 'unproven', UNSUPPORTED_STATUS: 'unproven',
};

export interface Finding { code: FindingCode; detail?: string; from?: number; to?: number }

export type CertificateAssessment =
  | { kind: 'invalid'; reason: string }
  | {
      kind: 'assessed';
      state: AssessmentState;
      findings: Finding[];
      window: { from: number; to: number };
      intervals: readonly StateInterval[];
      historicalTierVerified: false;
      issuanceAuthorized: false;
      redemptionAuthorized: false;
    };

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const sameIdentity = (a: ScopedIdentity, b: ScopedIdentity) =>
  a.providerAccountId === b.providerAccountId && a.livemode === b.livemode && a.businessId === b.businessId && a.bindingRevision === b.bindingRevision &&
  a.customerId === b.customerId && a.subscriptionId === b.subscriptionId;

/** Missing sub-ranges of [from, to) not covered by the union of `ranges` (ranges may overlap or extend outside). */
function uncovered(from: number, to: number, ranges: readonly { from: number; to: number }[]): { from: number; to: number }[] {
  const sorted = [...ranges].filter(r => r.to > r.from).sort((a, b) => a.from - b.from);
  const gaps: { from: number; to: number }[] = [];
  let cursor = from;
  for (const r of sorted) {
    if (r.to <= cursor) continue;
    if (r.from > cursor) gaps.push({ from: cursor, to: Math.min(r.from, to) });
    cursor = Math.max(cursor, r.to);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push({ from: cursor, to });
  return gaps.filter(g => g.to > g.from);
}

export function assessHistoricalTierCertificate(input: {
  identity: ScopedIdentity;
  window: { from: number; to: number };
  intervals: readonly StateInterval[];
  proof: ProofBundle;
}): CertificateAssessment {
  const { identity, window, intervals, proof } = input ?? ({} as Partial<typeof input>);
  if (!identity || !window || !proof || !Array.isArray(intervals)) return { kind: 'invalid', reason: 'MALFORMED_INPUT' };
  if (!fin(window.from) || !fin(window.to) || window.from >= window.to) return { kind: 'invalid', reason: 'INVALID_WINDOW' };
  if (!fin(proof.inceptionAt) || typeof proof.ruleVersion !== 'string' || proof.ruleVersion === '') return { kind: 'invalid', reason: 'INVALID_PROOF' };
  for (const i of intervals) {
    if (!i || !fin(i.effectiveFrom) || !fin(i.effectiveTo)) return { kind: 'invalid', reason: 'NON_FINITE_INTERVAL' };
    if (i.effectiveFrom >= i.effectiveTo) return { kind: 'invalid', reason: 'ZERO_OR_INVERTED_INTERVAL' };
  }
  for (const c of proof.coverage ?? []) if (!c || !fin(c.from) || !fin(c.to) || c.from >= c.to) return { kind: 'invalid', reason: 'INVALID_COVERAGE_ATTESTATION' };

  const findings: Finding[] = [];
  const add = (code: FindingCode, extra: Omit<Finding, 'code'> = {}) => findings.push({ code, ...extra });
  const sorted = [...intervals].sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.effectiveTo - b.effectiveTo);

  // identity and conflicts
  if (sorted.some(i => !sameIdentity(i.identity, identity))) add('IDENTITY_MISMATCH');
  for (const ref of proof.unresolvedConflictRefs ?? []) add('UNRESOLVED_CONFLICT', { detail: ref });

  // partition of W: no overlap, gaps explicit, adjacent intervals meet exactly, union covers W exactly after clipping
  const clipped = sorted.filter(i => i.effectiveTo > window.from && i.effectiveFrom < window.to);
  for (let k = 1; k < clipped.length; k++) {
    const prev = clipped[k - 1]!;
    const cur = clipped[k]!;
    if (cur.effectiveFrom < prev.effectiveTo) add('INTERVAL_OVERLAP', { from: cur.effectiveFrom, to: Math.min(prev.effectiveTo, cur.effectiveTo) });
  }
  for (const g of uncovered(window.from, window.to, clipped.map(i => ({ from: i.effectiveFrom, to: i.effectiveTo })))) add('COVERAGE_GAP', g);

  for (const i of clipped) {
    if (i.fromBoundary !== 'proved' || i.toBoundary !== 'proved') add('UNCERTAIN_BOUNDARY', { from: i.effectiveFrom, to: i.effectiveTo });
    if (i.state.planKey === null) add('UNMAPPED_PRICE', { detail: i.state.priceId });
    if (i.state.itemCount !== 1) add('UNSUPPORTED_ITEM_COUNT', { detail: String(i.state.itemCount) });
    if (i.state.interval !== 'month') add('UNSUPPORTED_INTERVAL', { detail: i.state.interval });
    if (i.state.currency !== 'usd') add('UNSUPPORTED_CURRENCY', { detail: i.state.currency });
    if (i.state.status !== 'active') add('UNSUPPORTED_STATUS', { detail: i.state.status }); // trial/canceled/etc. stay explicit states, never inferred eligible
  }

  // proof bundle obligations
  if (!proof.initialStateVerified) add('INITIAL_STATE_UNPROVEN');
  if (!proof.mutationPathInventoryComplete) add('MUTATION_PATH_INVENTORY_INCOMPLETE');
  if (!proof.manifestIntegrityVerified) add('MANIFEST_INTEGRITY_UNVERIFIED');
  if (!proof.catalogMappingVerified) add('CATALOG_MAPPING_UNVERIFIED');
  if (proof.completenessGuaranteeRef === null || proof.completenessGuaranteeRef === '') add('NO_SOURCE_COMPLETENESS_GUARANTEE');
  // chain must be attested from verified inception through the end of W, source by source
  const attested = (proof.coverage ?? []).filter(c => c.attested).map(c => ({ from: c.from, to: c.to }));
  for (const g of uncovered(Math.min(proof.inceptionAt, window.from), window.to, attested.length ? attested : [])) add('ATTESTATION_GAP', g);
  if (proof.manifest === null) add('NO_MANIFEST');
  else {
    if (proof.manifest.truncated) add('MANIFEST_TRUNCATED');
    if (proof.manifest.errorCount > 0) add('MANIFEST_ERRORS', { detail: String(proof.manifest.errorCount) });
    if (proof.manifest.retentionGapRanges > 0) add('RETENTION_GAP', { detail: String(proof.manifest.retentionGapRanges) });
    if (proof.manifest.cutoff < window.to) add('MANIFEST_CUTOFF_BEFORE_WINDOW_END');
  }

  const rank: AssessmentState[] = ['conflicted', 'incomplete', 'unproven'];
  const state = rank.find(r => findings.some(f => CLASS[f.code] === r)) ?? 'certified';
  return { kind: 'assessed', state, findings, window: { from: window.from, to: window.to }, intervals: clipped, historicalTierVerified: false, issuanceAuthorized: false, redemptionAuthorized: false };
}

export type TierCandidate =
  | { found: true; interval: StateInterval; historicalTierVerified: false; issuanceAuthorized: false; redemptionAuthorized: false }
  | { found: false; reason: 'ASSESSMENT_NOT_CERTIFIED' | 'OUTSIDE_WINDOW' | 'INVALID_INSTANT' | 'NOT_UNIQUE'; historicalTierVerified: false; issuanceAuthorized: false; redemptionAuthorized: false };

/**
 * The single candidate state interval at `instant` (half-open: the old interval excludes the boundary, the new one includes it). Only a certified
 * assessment yields a candidate, and even that is not authority: all authority flags stay false.
 */
export function candidateStateAt(assessment: CertificateAssessment, instant: number): TierCandidate {
  const no = (reason: Extract<TierCandidate, { found: false }>['reason']): TierCandidate => ({ found: false, reason, historicalTierVerified: false, issuanceAuthorized: false, redemptionAuthorized: false });
  if (assessment.kind !== 'assessed' || assessment.state !== 'certified') return no('ASSESSMENT_NOT_CERTIFIED');
  if (!fin(instant)) return no('INVALID_INSTANT');
  if (instant < assessment.window.from || instant >= assessment.window.to) return no('OUTSIDE_WINDOW'); // a certificate for one window never implies another
  const hits = assessment.intervals.filter(i => i.effectiveFrom <= instant && instant < i.effectiveTo);
  if (hits.length !== 1) return no('NOT_UNIQUE');
  return { found: true, interval: hits[0]!, historicalTierVerified: false, issuanceAuthorized: false, redemptionAuthorized: false };
}
