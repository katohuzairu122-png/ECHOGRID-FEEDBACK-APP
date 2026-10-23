import { describe, it, expect } from 'vitest';
import {
  assessHistoricalTierCertificate, candidateStateAt,
  type CertificateAssessment, type ProofBundle, type ScopedIdentity, type StateInterval,
} from './historical-tier-certificate.assessment';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const ID: ScopedIdentity = { providerAccountId: 'acct_A', livemode: true, businessId: 'biz-1', bindingRevision: 1, customerId: 'cus_1', subscriptionId: 'sub_1' };
const WINDOW = { from: T0 + 10 * DAY, to: T0 + 100 * DAY };
const interval = (from: number, to: number, over: Partial<StateInterval['state']> = {}, extra: Partial<StateInterval> = {}): StateInterval => ({
  effectiveFrom: from, effectiveTo: to, identity: ID,
  state: { priceId: 'price_growth', planKey: 'growth', status: 'active', currency: 'usd', interval: 'month', itemCount: 1, ...over },
  fromBoundary: 'proved', toBoundary: 'proved', mappingRevision: 'map-1', sourceRefs: ['evt_1'], ...extra,
});
const goodIntervals = (): StateInterval[] => [
  interval(T0, T0 + 50 * DAY),
  interval(T0 + 50 * DAY, T0 + 120 * DAY, { priceId: 'price_starter', planKey: 'starter' }),
];
const goodProof = (): ProofBundle => ({
  ruleVersion: 'HETA-01D/1', inceptionAt: T0, initialStateVerified: true, mutationPathInventoryComplete: true,
  coverage: [{ sourceId: 'webhook', from: T0, to: T0 + 200 * DAY, attested: true }, { sourceId: 'api_retrieval', from: T0, to: T0 + 200 * DAY, attested: true }],
  manifest: { cutoff: T0 + 150 * DAY, truncated: false, errorCount: 0, retentionGapRanges: 0 },
  manifestIntegrityVerified: true, catalogMappingVerified: true, completenessGuaranteeRef: 'guarantee-ref-FIXTURE', unresolvedConflictRefs: [],
});
const assess = (over: { intervals?: StateInterval[]; proof?: Partial<ProofBundle>; window?: { from: number; to: number } } = {}) =>
  assessHistoricalTierCertificate({ identity: ID, window: over.window ?? WINDOW, intervals: over.intervals ?? goodIntervals(), proof: { ...goodProof(), ...over.proof } });
const stateOf = (a: CertificateAssessment) => (a.kind === 'assessed' ? a.state : a.reason);
const codes = (a: CertificateAssessment) => (a.kind === 'assessed' ? a.findings.map(f => f.code) : []);

describe('HETA-01D logical certificate assessment (pure; authority flags are always false)', () => {
  it('a fully proved fixture is logically certified, and still carries no authority', () => {
    const a = assess();
    expect(a).toMatchObject({ kind: 'assessed', state: 'certified', findings: [], historicalTierVerified: false, issuanceAuthorized: false, redemptionAuthorized: false });
  });

  it('without a documented source completeness guarantee the result is unproven, however complete everything else is (the deployment as it stands)', () => {
    for (const ref of [null, '']) expect(assess({ proof: { completenessGuaranteeRef: ref } })).toMatchObject({ state: 'unproven', findings: [{ code: 'NO_SOURCE_COMPLETENESS_GUARANTEE' }] });
  });

  it.each([
    ['gap inside the window', { intervals: [interval(T0, T0 + 40 * DAY), interval(T0 + 60 * DAY, T0 + 120 * DAY)] }, 'incomplete', 'COVERAGE_GAP'],
    ['window start not covered', { intervals: [interval(T0 + 20 * DAY, T0 + 120 * DAY)] }, 'incomplete', 'COVERAGE_GAP'],
    ['window end not covered (no extrapolation of the last state)', { intervals: [interval(T0, T0 + 90 * DAY)] }, 'incomplete', 'COVERAGE_GAP'],
    ['no intervals at all', { intervals: [] }, 'incomplete', 'COVERAGE_GAP'],
    ['overlapping intervals', { intervals: [interval(T0, T0 + 60 * DAY), interval(T0 + 50 * DAY, T0 + 120 * DAY, { planKey: 'starter' })] }, 'conflicted', 'INTERVAL_OVERLAP'],
    ['uncertain boundary', { intervals: [interval(T0, T0 + 50 * DAY, {}, { toBoundary: 'uncertain' }), interval(T0 + 50 * DAY, T0 + 120 * DAY, { planKey: 'starter' }, { fromBoundary: 'uncertain' })] }, 'unproven', 'UNCERTAIN_BOUNDARY'],
    ['unmapped price', { intervals: [interval(T0, T0 + 120 * DAY, { planKey: null })] }, 'unproven', 'UNMAPPED_PRICE'],
    ['multi-item subscription', { intervals: [interval(T0, T0 + 120 * DAY, { itemCount: 2 })] }, 'unproven', 'UNSUPPORTED_ITEM_COUNT'],
    ['annual interval', { intervals: [interval(T0, T0 + 120 * DAY, { interval: 'year' })] }, 'unproven', 'UNSUPPORTED_INTERVAL'],
    ['non-USD currency', { intervals: [interval(T0, T0 + 120 * DAY, { currency: 'eur' })] }, 'unproven', 'UNSUPPORTED_CURRENCY'],
    ['trial status is an explicit denial, not eligibility', { intervals: [interval(T0, T0 + 120 * DAY, { status: 'trialing' })] }, 'unproven', 'UNSUPPORTED_STATUS'],
    ['canceled status', { intervals: [interval(T0, T0 + 120 * DAY, { status: 'canceled' })] }, 'unproven', 'UNSUPPORTED_STATUS'],
    ['identity of an interval differs (account / mode / business / revision / subscription)', { intervals: [{ ...interval(T0, T0 + 120 * DAY), identity: { ...ID, providerAccountId: 'acct_B' } }] }, 'conflicted', 'IDENTITY_MISMATCH'],
    ['unresolved conflict reference', { proof: { unresolvedConflictRefs: ['digest-differs'] } }, 'conflicted', 'UNRESOLVED_CONFLICT'],
    ['initial state not verified', { proof: { initialStateVerified: false } }, 'unproven', 'INITIAL_STATE_UNPROVEN'],
    ['mutation path inventory incomplete (portal/dashboard/api unknown)', { proof: { mutationPathInventoryComplete: false } }, 'unproven', 'MUTATION_PATH_INVENTORY_INCOMPLETE'],
    ['manifest integrity unverified', { proof: { manifestIntegrityVerified: false } }, 'unproven', 'MANIFEST_INTEGRITY_UNVERIFIED'],
    ['catalog mapping unverified', { proof: { catalogMappingVerified: false } }, 'unproven', 'CATALOG_MAPPING_UNVERIFIED'],
    ['no reconciliation manifest', { proof: { manifest: null } }, 'incomplete', 'NO_MANIFEST'],
    ['truncated retrieval (e.g. a 100-row limit)', { proof: { manifest: { cutoff: T0 + 150 * DAY, truncated: true, errorCount: 0, retentionGapRanges: 0 } } }, 'incomplete', 'MANIFEST_TRUNCATED'],
    ['retrieval errors', { proof: { manifest: { cutoff: T0 + 150 * DAY, truncated: false, errorCount: 2, retentionGapRanges: 0 } } }, 'incomplete', 'MANIFEST_ERRORS'],
    ['retention loss', { proof: { manifest: { cutoff: T0 + 150 * DAY, truncated: false, errorCount: 0, retentionGapRanges: 1 } } }, 'incomplete', 'RETENTION_GAP'],
    ['retrieval cutoff before the window ends', { proof: { manifest: { cutoff: T0 + 90 * DAY, truncated: false, errorCount: 0, retentionGapRanges: 0 } } }, 'incomplete', 'MANIFEST_CUTOFF_BEFORE_WINDOW_END'],
    ['capture outage: an attestation gap inside the chain', { proof: { coverage: [{ sourceId: 'webhook', from: T0, to: T0 + 30 * DAY, attested: true }, { sourceId: 'webhook', from: T0 + 40 * DAY, to: T0 + 200 * DAY, attested: true }] } }, 'incomplete', 'ATTESTATION_GAP'],
    ['coverage unattested', { proof: { coverage: [{ sourceId: 'webhook', from: T0, to: T0 + 200 * DAY, attested: false }] } }, 'incomplete', 'ATTESTATION_GAP'],
    ['history before the window is unattested (a later checkpoint cannot erase prior history)', { proof: { coverage: [{ sourceId: 'webhook', from: T0 + 10 * DAY, to: T0 + 200 * DAY, attested: true }] } }, 'incomplete', 'ATTESTATION_GAP'],
  ] as const)('%s', (_n, over, state, code) => {
    const a = assess(over as never);
    expect(stateOf(a)).toBe(state);
    expect(codes(a)).toContain(code);
    expect(a).toMatchObject({ historicalTierVerified: false, issuanceAuthorized: false, redemptionAuthorized: false });
  });

  it('aggregates with precedence conflicted > incomplete > unproven and retains every finding', () => {
    const a = assess({ intervals: [interval(T0, T0 + 60 * DAY), interval(T0 + 50 * DAY, T0 + 90 * DAY)], proof: { manifest: null, initialStateVerified: false, unresolvedConflictRefs: ['x'] } });
    expect(stateOf(a)).toBe('conflicted');
    expect(codes(a)).toEqual(expect.arrayContaining(['INTERVAL_OVERLAP', 'COVERAGE_GAP', 'NO_MANIFEST', 'INITIAL_STATE_UNPROVEN', 'UNRESOLVED_CONFLICT']));
    expect(stateOf(assess({ proof: { manifest: null, initialStateVerified: false } }))).toBe('incomplete');
  });

  it('reports gap ranges explicitly instead of filling them from the nearest observation', () => {
    const a = assess({ intervals: [interval(T0, T0 + 40 * DAY), interval(T0 + 60 * DAY, T0 + 120 * DAY)] });
    expect(a.kind === 'assessed' && a.findings.find(f => f.code === 'COVERAGE_GAP')).toEqual({ code: 'COVERAGE_GAP', from: T0 + 40 * DAY, to: T0 + 60 * DAY });
  });

  it('rejects invalid input before any trusted assessment', () => {
    expect(assess({ window: { from: 5, to: 5 } })).toEqual({ kind: 'invalid', reason: 'INVALID_WINDOW' });
    expect(assess({ window: { from: Number.NaN, to: 5 } })).toEqual({ kind: 'invalid', reason: 'INVALID_WINDOW' });
    expect(assess({ intervals: [interval(T0, T0)] })).toEqual({ kind: 'invalid', reason: 'ZERO_OR_INVERTED_INTERVAL' });
    expect(assess({ intervals: [interval(T0 + 5, T0)] })).toEqual({ kind: 'invalid', reason: 'ZERO_OR_INVERTED_INTERVAL' });
    expect(assess({ intervals: [interval(T0, Number.POSITIVE_INFINITY)] })).toEqual({ kind: 'invalid', reason: 'NON_FINITE_INTERVAL' });
    expect(assess({ proof: { ruleVersion: '' } })).toEqual({ kind: 'invalid', reason: 'INVALID_PROOF' });
    expect(assess({ proof: { coverage: [{ sourceId: 's', from: 9, to: 3, attested: true }] } })).toEqual({ kind: 'invalid', reason: 'INVALID_COVERAGE_ATTESTATION' });
    expect(assessHistoricalTierCertificate(undefined as never)).toEqual({ kind: 'invalid', reason: 'MALFORMED_INPUT' });
  });

  it('half-open boundaries: the old interval excludes the boundary, the new one includes it, and the window end is outside coverage', () => {
    const a = assess();
    const b = T0 + 50 * DAY;
    expect(candidateStateAt(a, b - 1)).toMatchObject({ found: true, interval: { state: { planKey: 'growth' } } });
    expect(candidateStateAt(a, b)).toMatchObject({ found: true, interval: { state: { planKey: 'starter' } }, historicalTierVerified: false });
    expect(candidateStateAt(a, WINDOW.to)).toMatchObject({ found: false, reason: 'OUTSIDE_WINDOW' });
    expect(candidateStateAt(a, WINDOW.from - 1)).toMatchObject({ found: false, reason: 'OUTSIDE_WINDOW' }); // one window never implies another
    expect(candidateStateAt(a, Number.NaN)).toMatchObject({ found: false, reason: 'INVALID_INSTANT' });
  });

  it('never yields a candidate from an uncertified assessment, and never any authority', () => {
    for (const a of [assess({ proof: { completenessGuaranteeRef: null } }), assess({ intervals: [] }), assess({ window: { from: 9, to: 9 } })]) {
      expect(candidateStateAt(a, T0 + 60 * DAY)).toEqual({ found: false, reason: 'ASSESSMENT_NOT_CERTIFIED', historicalTierVerified: false, issuanceAuthorized: false, redemptionAuthorized: false });
    }
  });

  it('property: certified exactly when there is no defect; any single injected defect prevents certification; deterministic', () => {
    expect(stateOf(assess())).toBe('certified');
    const breakers: Array<() => CertificateAssessment> = [
      () => assess({ proof: { initialStateVerified: false } }), () => assess({ proof: { mutationPathInventoryComplete: false } }),
      () => assess({ proof: { manifestIntegrityVerified: false } }), () => assess({ proof: { catalogMappingVerified: false } }),
      () => assess({ proof: { completenessGuaranteeRef: null } }), () => assess({ proof: { manifest: null } }),
      () => assess({ proof: { unresolvedConflictRefs: ['c'] } }), () => assess({ intervals: [interval(T0, T0 + 50 * DAY)] }),
      () => assess({ intervals: [interval(T0, T0 + 120 * DAY, { planKey: null })] }),
    ];
    for (const b of breakers) { expect(stateOf(b())).not.toBe('certified'); expect(b()).toEqual(b()); }
    let seed = 99;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 400; i++) {
      const cut = T0 + (11 + rnd(80)) * DAY;
      const a = assess({ intervals: [interval(T0, cut), interval(cut, T0 + 120 * DAY, { planKey: 'starter' })] });
      expect(stateOf(a)).toBe('certified');
      const at = WINDOW.from + rnd(90 * DAY);
      const c = candidateStateAt(a, at);
      expect(c.found && c.interval.state.planKey).toBe(at < cut ? 'growth' : 'starter');
    }
  });
});
