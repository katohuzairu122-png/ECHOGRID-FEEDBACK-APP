/** NETWORK-15-T1 reference model ONLY. No runtime export/import or approved customer terms. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const NOW = '2026-11-21T00:00:00.000Z';
type Publication = { approved: boolean; published: boolean; effectiveAt: string; version: string; hash: string };
type Identity = { authenticated: boolean; customerId: string; active: boolean; verifiedPhone: boolean };
type Event = { id: string; customerId: string; membershipId: string; operation: 'join' | 'rejoin' | 'leave';
  version: string | null; hash: string | null; acceptedAt: string; explicit: boolean; grantId: string | null; basis: string | null };
type State = { customerId: string; status: 'absent' | 'active' | 'left' | 'suspended'; accountSuspended: boolean;
  membershipId: string | null; accountId: string | null; basis: string | null;
  points: number; ledger: string[]; businessPoints: Record<string, number>;
  events: Event[]; grants: { id: string; eventId: string; status: 'active' | 'revoked' }[];
  replays: { key: string; fingerprint: string; basisAfter: string }[] };
const initial = (): State => ({ customerId: 'synthetic-customer', status: 'absent', accountSuspended: false,
  membershipId: null, accountId: null, basis: null, points: 0, ledger: [],
  businessPoints: { 'synthetic-business': 150 }, events: [], grants: [], replays: [] });
const identity = (): Identity => ({ authenticated: true, customerId: 'synthetic-customer', active: true, verifiedPhone: true });
// Synthetic approval exists only to test proposed rules; it is NOT approval of community-membership-v1.0.
const fixture = (): Publication => ({ approved: true, published: true, effectiveAt: '2026-01-01T00:00:00.000Z',
  version: 'synthetic-approved-fixture', hash: digest('SYNTHETIC DESIGN FIXTURE — NOT CUSTOMER TERMS') });
const request = (state = initial(), publication = fixture()) => ({ operation: state.status === 'left' ? 'rejoin' : 'join',
  consentAccepted: true, expectedTermsVersion: publication.version, expectedTermsHash: publication.hash,
  expectedTransitionId: state.basis, idempotencyKey: `synthetic-request-key:${state.basis ?? 'initial'}` });
function refuse(code: string): never { throw new Error(code); }

/** Executable proposed transaction semantics, not a substitute for unimplemented production storage/authorization. */
function accept(state: State, actor: Identity, raw: unknown, publication: Publication | null, auditFails = false): State {
  if (!actor.authenticated || actor.customerId !== state.customerId) refuse('UNAUTHENTICATED');
  if (!actor.active || state.status === 'suspended' || state.accountSuspended) refuse('SUSPENDED');
  if (!actor.verifiedPhone) refuse('PHONE_VERIFICATION_REQUIRED');
  if (!publication?.approved || !publication.published || publication.effectiveAt > NOW) refuse('TERMS_UNAVAILABLE');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) refuse('INVALID_REQUEST');
  const input = raw as Record<string, unknown>;
  const allowed = ['operation', 'consentAccepted', 'expectedTermsVersion', 'expectedTermsHash', 'expectedTransitionId', 'idempotencyKey'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) refuse('INVALID_REQUEST');
  if (input.consentAccepted !== true) refuse('CONSENT_REQUIRED');
  if (input.expectedTermsVersion !== publication.version) refuse('TERMS_MISMATCH');
  if (input.expectedTermsHash !== publication.hash) refuse('ACCEPTANCE_STALE');
  if (input.operation !== 'join' && input.operation !== 'rejoin') refuse('INVALID_OPERATION');
  if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey || input.idempotencyKey.length > 100) refuse('INVALID_REQUEST');
  const key = digest(JSON.stringify([actor.customerId, input.idempotencyKey]));
  const fingerprint = digest(JSON.stringify([actor.customerId, input.operation, publication.version, publication.hash, input.expectedTransitionId]));
  const existing = state.replays.find((item) => item.key === key);
  if (existing) {
    if (existing.fingerprint !== fingerprint || existing.basisAfter !== state.basis) refuse('ACCEPTANCE_STALE');
    return structuredClone(state);
  }
  if (input.expectedTransitionId !== state.basis) refuse('ACCEPTANCE_STALE');
  if (state.status === 'active') refuse('ALREADY_ACTIVE');
  if ((state.status === 'absent') !== (input.operation === 'join')) refuse('INVALID_OPERATION');
  const next = structuredClone(state);
  next.membershipId ??= `synthetic-membership:${actor.customerId}`;
  next.accountId ??= `synthetic-account:${actor.customerId}`;
  const id = randomUUID();
  const grantId = randomUUID();
  next.events.push({ id, customerId: actor.customerId, membershipId: next.membershipId, operation: input.operation,
    version: publication.version, hash: publication.hash, acceptedAt: NOW, explicit: true, grantId, basis: state.basis });
  next.grants.push({ id: grantId, eventId: id, status: 'active' });
  next.status = 'active'; next.basis = id;
  next.replays.push({ key, fingerprint, basisAfter: id });
  if (auditFails) refuse('MANDATORY_EVIDENCE_FAILED');
  return next;
}
function leave(state: State): State {
  if (state.status === 'suspended') refuse('SUSPENDED');
  if (state.status === 'left') return structuredClone(state);
  if (state.status !== 'active' || !state.membershipId) refuse('MEMBERSHIP_MISSING');
  const next = structuredClone(state);
  const id = randomUUID();
  next.events.push({ id, customerId: state.customerId, membershipId: state.membershipId, operation: 'leave',
    version: null, hash: null, acceptedAt: NOW, explicit: false, grantId: null, basis: state.basis });
  next.grants.forEach((grant) => { grant.status = 'revoked'; });
  next.status = 'left'; next.basis = id;
  return next;
}
const joined = () => accept(initial(), identity(), request(), fixture());

// Distinct tests map to T1-01..16. Additional checks do not imply live enrollment acceptance.
describe('NETWORK-15-T1 proposed consent reference model (NOT runtime enforcement)', () => {
  it('T1-01 no approved terms blocks Join', () => {
    expect(() => accept(initial(), identity(), request(), null)).toThrow('TERMS_UNAVAILABLE');
    expect(() => accept(initial(), identity(), request(), { ...fixture(), approved: false })).toThrow('TERMS_UNAVAILABLE');
  });
  it('T1-02 no approved terms blocks Rejoin', () => {
    const left = leave(joined());
    expect(() => accept(left, identity(), request(left), null)).toThrow('TERMS_UNAVAILABLE');
  });
  it('T1-03 explicit acceptance cannot be missing, false or truthy', () => {
    for (const consentAccepted of [undefined, false, 'true', 1, null])
      expect(() => accept(initial(), identity(), { ...request(), consentAccepted }, fixture())).toThrow('CONSENT_REQUIRED');
  });
  it('T1-04 a client-selected unknown version is not publication authority', () => {
    expect(() => accept(initial(), identity(), { ...request(), expectedTermsVersion: 'unapproved-v99' }, fixture())).toThrow('TERMS_MISMATCH');
  });
  it('T1-05 stale artifact/current-version views require new explicit acceptance', () => {
    expect(() => accept(initial(), identity(), request(), { ...fixture(), hash: digest('changed') })).toThrow('ACCEPTANCE_STALE');
    expect(() => accept(initial(), identity(), request(), { ...fixture(), version: 'different-effective-version' })).toThrow('TERMS_MISMATCH');
  });
  it('T1-06 unverified phone is denied', () => {
    expect(() => accept(initial(), { ...identity(), verifiedPhone: false }, request(), fixture())).toThrow('PHONE_VERIFICATION_REQUIRED');
  });
  it('T1-07 inactive identity and suspended membership/account are denied', () => {
    expect(() => accept(initial(), { ...identity(), active: false }, request(), fixture())).toThrow('SUSPENDED');
    expect(() => accept({ ...initial(), status: 'suspended' }, identity(), request(), fixture())).toThrow('SUSPENDED');
    expect(() => accept({ ...initial(), accountSuspended: true }, identity(), request(), fixture())).toThrow('SUSPENDED');
  });
  it('T1-08 matching duplicate Join returns the committed evidence once', () => {
    const active = joined();
    expect(accept(active, identity(), request(), fixture())).toEqual(active);
    expect(active.events).toHaveLength(1); expect(active.grants).toHaveLength(1);
  });
  it('T1-09 simulated serialized Rejoin contention preserves one membership/evidence (not a PG proof)', async () => {
    let state = leave(joined()); const raw = request(state);
    let queue = Promise.resolve();
    await Promise.all(Array.from({ length: 8 }, () => {
      queue = queue.then(() => { state = accept(state, identity(), raw, fixture()); }); return queue;
    }));
    expect(state.membershipId).toBe(joined().membershipId);
    expect(state.events.filter((event) => event.operation === 'rejoin')).toHaveLength(1);
    expect(state.grants.filter((grant) => grant.status === 'active')).toHaveLength(1);
  });
  it('T1-10 evidence binds the server identity, exact artifact and transition', () => {
    const state = joined(); const event = state.events[0]!;
    expect(event).toMatchObject({ customerId: state.customerId, membershipId: state.membershipId,
      version: fixture().version, hash: fixture().hash, acceptedAt: NOW, operation: 'join', explicit: true });
    expect(state.grants[0]!.eventId).toBe(event.id); expect(state.basis).toBe(event.id);
  });
  it('T1-11 Leave preserves acceptance and ledger history; stale Join cannot resurrect', () => {
    const active = joined(); active.points = 80; active.ledger = ['existing-authorized-fixture-award'];
    const left = leave(active);
    expect(left.events[0]).toEqual(active.events[0]); expect(left.ledger).toEqual(active.ledger);
    expect(left.points).toBe(active.points); expect(leave(left)).toEqual(left);
    expect(() => accept(left, identity(), request(), fixture())).toThrow('ACCEPTANCE_STALE');
  });
  it('T1-12 business loyalty stays independent across Join/Leave/Rejoin', () => {
    const start = initial(); const active = accept(start, identity(), request(), fixture()); const left = leave(active);
    expect(accept(left, identity(), request(left), fixture()).businessPoints).toEqual(start.businessPoints);
  });
  it('T1-13 membership acceptance creates no point rule, amount or award', () => {
    const start = initial(); const state = joined();
    expect(state.points).toBe(start.points); expect(state.ledger).toEqual(start.ledger);
  });
  it('T1-14 another customer cannot modify this membership or select a customer field', () => {
    const state = initial();
    expect(() => accept(state, { ...identity(), customerId: 'other' }, request(), fixture())).toThrow('UNAUTHENTICATED');
    expect(() => accept(state, identity(), { ...request(), customerId: 'other' }, fixture())).toThrow('INVALID_REQUEST');
    expect(state).toEqual(initial());
  });
  it('T1-15 current application exposes no draft Join/Rejoin action from navigation or verification', () => {
    const source = readFileSync(resolve('../web/src/lib/actions/community-membership.ts'), 'utf8');
    expect(source).not.toMatch(/export\s+async\s+function\s+(?:join|rejoin)/i);
    const controls = readFileSync(resolve('../web/src/app/loyalty/dashboard/community/membership-controls.tsx'), 'utf8');
    expect(controls).not.toContain('community-membership-v1.0');
    expect(controls).not.toContain('consentAccepted');
  });
  it('T1-16 client timestamps/approval/identity assertions cannot become evidence', () => {
    for (const key of ['acceptedAt', 'verified', 'approved', 'auditId', 'grantId', 'businessId'])
      expect(() => accept(initial(), identity(), { ...request(), [key]: NOW }, fixture())).toThrow('INVALID_REQUEST');
    expect(joined().events[0]!.acceptedAt).toBe(NOW);
  });
  it('mandatory evidence failure rolls back the proposed transition', () => {
    const state = initial();
    expect(() => accept(state, identity(), request(), fixture(), true)).toThrow('MANDATORY_EVIDENCE_FAILED');
    expect(state).toEqual(initial());
  });
  it('future-effective terms cannot open enrollment', () => {
    expect(() => accept(initial(), identity(), request(), { ...fixture(), effectiveAt: '2099-01-01T00:00:00.000Z' })).toThrow('TERMS_UNAVAILABLE');
  });
  it('a changed request key while already active is not fresh acceptance', () => {
    const active = joined();
    expect(() => accept(active, identity(), { ...request(active), idempotencyKey: 'new-key' }, fixture())).toThrow('ALREADY_ACTIVE');
  });
  it('the repository candidate remains a draft without an effective date', () => {
    const draft = readFileSync(resolve('../../docs/architecture/builds/NETWORK/NETWORK-15-T1/COMMUNITY_MEMBERSHIP_TERMS_DRAFT.md'), 'utf8');
    expect(draft).toContain('DRAFT — NOT APPROVED — NOT EFFECTIVE — NOT SERVED TO CUSTOMERS');
    expect(draft).toContain('Proposed version: `community-membership-v1.0`');
    expect(draft).toContain('Effective date: none'); expect(draft).toContain('Activation: disabled');
    expect(digest(draft)).toMatch(/^[a-f0-9]{64}$/); expect(digest(draft + '\n')).not.toBe(digest(draft));
  });
});
