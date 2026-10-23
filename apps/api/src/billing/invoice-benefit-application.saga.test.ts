import { describe, it, expect } from 'vitest';
import {
  classifyPresentEffect, startApplication, transition,
  type ApplicationBase, type ApplicationEffect, type ApplicationEvent, type ApplicationState, type ProviderObservation,
} from './invoice-benefit-application.saga';

const BASE: ApplicationBase = { reservationRef: 'res-1', businessId: 'biz-1', invoiceRef: 'in_1', units: 3, expectedBenefitMinor: 300, currency: 'usd', policyVersion: 'PC-BENEFIT/1' };
const matched: ProviderObservation = { status: 'effect_present', effectRef: 'ef_1', amountMinor: 300, currency: 'usd', invoiceRef: 'in_1', attributedToReservationRef: 'res-1' };
const step = (s: ApplicationState, e: ApplicationEvent) => { const r = transition(s, e); if (!r.ok) throw new Error('rejected ' + r.code); return r; };
const begin = (s: ApplicationState, key = 'a1', at = 10) => step(s, { type: 'begin_apply', attemptKey: key, at }).state;

describe('benefit application saga (pure; effects are declarative, nothing is executed)', () => {
  it('reserved -> applying -> consumed only on a provider effect attributed to this reservation with the exact amount', () => {
    const applying = begin(startApplication(BASE));
    const r = step(applying, { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 20 });
    expect(r.state).toMatchObject({ kind: 'consumed', providerEffectRef: 'ef_1', appliedAt: 20, compensations: [] });
    expect(r.effects).toEqual([{ type: 'consume', reservationRef: 'res-1', units: 3, providerEffectRef: 'ef_1', benefitMinor: 300 }]);
  });

  it.each([
    ['wrong amount', { amountMinor: 301 }],
    ['wrong currency', { currency: 'eur' }],
    ['wrong invoice', { invoiceRef: 'in_2' }],
    ['attributed to another reservation', { attributedToReservationRef: 'res-2' }],
  ] as const)('never consumes on a mismatching effect (%s): retains for reconciliation', (_n, over) => {
    const r = step(begin(startApplication(BASE)), { type: 'provider_observation', attemptKey: 'a1', observation: { ...matched, ...over }, at: 20 });
    expect(r.state).toMatchObject({ kind: 'retained', cause: 'PROVIDER_EFFECT_MISMATCH' });
    expect(r.effects).toEqual([{ type: 'flag_for_reconciliation', reservationRef: 'res-1', cause: 'PROVIDER_EFFECT_MISMATCH' }]);
  });

  it('an unattributed effect (no reservation attribution or no reference) is retained, never consumed', () => {
    for (const obs of [{ ...matched, attributedToReservationRef: null }, { ...matched, effectRef: ' ' }]) {
      expect(step(begin(startApplication(BASE)), { type: 'provider_observation', attemptKey: 'a1', observation: obs, at: 20 }).state).toMatchObject({ kind: 'retained', cause: 'PROVIDER_EFFECT_UNATTRIBUTED' });
    }
    expect(classifyPresentEffect(BASE, matched)).toBe('matched');
  });

  it('releases only when the provider confirmed NO effect in a query made after the attempt began', () => {
    const applying = begin(startApplication(BASE), 'a1', 100);
    const stale = step(applying, { type: 'provider_observation', attemptKey: 'a1', observation: { status: 'effect_absent', checkedAt: 99 }, at: 150 });
    expect(stale.state).toMatchObject({ kind: 'retained', cause: 'STALE_ABSENCE' });
    expect(stale.effects.map(e => e.type)).toEqual(['flag_for_reconciliation']);
    const fresh = step(stale.state, { type: 'provider_observation', attemptKey: 'a1', observation: { status: 'effect_absent', checkedAt: 101 }, at: 160 });
    expect(fresh.state).toMatchObject({ kind: 'released', cause: 'PROVIDER_CONFIRMED_NO_EFFECT' });
    expect(fresh.effects).toEqual([{ type: 'release', reservationRef: 'res-1', units: 3, cause: 'PROVIDER_CONFIRMED_NO_EFFECT' }]);
  });

  it('an unreachable provider retains (never releases) and a later match still consumes', () => {
    const retained = step(begin(startApplication(BASE)), { type: 'provider_observation', attemptKey: 'a1', observation: { status: 'unreachable' }, at: 20 });
    expect(retained.state).toMatchObject({ kind: 'retained', cause: 'PROVIDER_UNREACHABLE' });
    const again = step(retained.state, { type: 'provider_observation', attemptKey: 'a1', observation: { status: 'unreachable' }, at: 21 });
    expect(again.replay).toBe(true);
    expect(again.effects).toEqual([]);
    expect(step(retained.state, { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 30 }).state.kind).toBe('consumed');
  });

  it('replays are idempotent and a second provider attempt is refused', () => {
    const applying = begin(startApplication(BASE));
    expect(step(applying, { type: 'begin_apply', attemptKey: 'a1', at: 11 })).toMatchObject({ replay: true, effects: [] });
    expect(transition(applying, { type: 'begin_apply', attemptKey: 'a2', at: 11 })).toMatchObject({ ok: false, code: 'ATTEMPT_CONFLICT' });
    expect(transition(applying, { type: 'provider_observation', attemptKey: 'other', observation: matched, at: 20 })).toMatchObject({ ok: false, code: 'ATTEMPT_MISMATCH' });
    const consumed = step(applying, { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 20 }).state;
    expect(step(consumed, { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 21 })).toMatchObject({ replay: true, effects: [] });
    expect(transition(consumed, { type: 'begin_apply', attemptKey: 'a3', at: 22 })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('reversal before any attempt releases; reservation expiry releases only an unused reservation', () => {
    const r = step(startApplication(BASE), { type: 'reverse', reversalRef: 'rv1', at: 5 });
    expect(r.state).toMatchObject({ kind: 'released', cause: 'REVERSED_BEFORE_APPLICATION' });
    expect(step(startApplication(BASE), { type: 'release_unused', at: 5 }).state).toMatchObject({ kind: 'released', cause: 'RESERVATION_UNUSED' });
    expect(transition(begin(startApplication(BASE)), { type: 'release_unused', at: 6 })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    const consumed = step(begin(startApplication(BASE)), { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 20 }).state;
    expect(transition(consumed, { type: 'release_unused', at: 30 })).toMatchObject({ ok: false });
  });

  it('reversal after consumption appends exactly one negative entry per reversal reference and never edits history', () => {
    const consumed = step(begin(startApplication(BASE)), { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 20 }).state;
    const r1 = step(consumed, { type: 'reverse', reversalRef: 'rv1', at: 40 });
    expect(r1.effects).toEqual([{ type: 'append_compensation', reservationRef: 'res-1', units: -3, benefitMinor: -300, reversalRef: 'rv1', idempotencyKey: 'benefit-compensation:v1:res-1:rv1' }]);
    expect(r1.state).toMatchObject({ kind: 'consumed', providerEffectRef: 'ef_1', compensations: ['rv1'] });
    expect(step(r1.state, { type: 'reverse', reversalRef: 'rv1', at: 41 })).toMatchObject({ replay: true, effects: [] });
    expect(step(r1.state, { type: 'reverse', reversalRef: 'rv2', at: 42 }).effects).toHaveLength(1);
  });

  it('a reversal during an unresolved application is held (never released) and compensated if the provider effect is later confirmed', () => {
    const held = step(begin(startApplication(BASE)), { type: 'reverse', reversalRef: 'rv1', at: 15 });
    expect(held.state).toMatchObject({ kind: 'retained', cause: 'REVERSAL_DURING_APPLICATION', pendingReversalRefs: ['rv1'] });
    expect(held.effects.map(e => e.type)).toEqual(['flag_for_reconciliation']);
    expect(step(held.state, { type: 'reverse', reversalRef: 'rv1', at: 16 })).toMatchObject({ replay: true });
    const done = step(held.state, { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 30 });
    expect(done.state).toMatchObject({ kind: 'consumed', compensations: ['rv1'] });
    expect(done.effects.map(e => e.type)).toEqual(['consume', 'append_compensation']);
    // and if the provider confirms no effect, the credit is released (the reversal is moot)
    const none = step(held.state, { type: 'provider_observation', attemptKey: 'a1', observation: { status: 'effect_absent', checkedAt: 99 }, at: 100 });
    expect(none.state.kind).toBe('released');
  });

  it('rejects malformed events and refuses to build an invalid application', () => {
    expect(transition(startApplication(BASE), { type: 'begin_apply', attemptKey: '', at: 1 })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(transition(startApplication(BASE), { type: 'begin_apply', attemptKey: 'a', at: Number.NaN })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(transition(startApplication(BASE), { type: 'nope', at: 1 } as never)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(transition(begin(startApplication(BASE)), { type: 'provider_observation', attemptKey: 'a1', observation: { status: 'effect_present', effectRef: 'x', amountMinor: -1, currency: 'usd', invoiceRef: 'in_1', attributedToReservationRef: 'res-1' }, at: 2 })).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(transition(startApplication(BASE), { type: 'provider_observation', attemptKey: 'a1', observation: matched, at: 2 })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect(() => startApplication({ ...BASE, units: 0 })).toThrow('APPLICATION_BASE_INVALID');
    expect(() => startApplication({ ...BASE, currency: 'USD' })).toThrow('APPLICATION_BASE_INVALID');
  });

  it('property: over random event sequences, consumption needs a matched effect, happens at most once, never co-occurs with release, and each reversal compensates at most once', () => {
    let seed = 20261023;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const observations: ProviderObservation[] = [
      matched, { ...matched, amountMinor: 1 }, { ...matched, attributedToReservationRef: null }, { ...matched, invoiceRef: 'in_x' },
      { status: 'effect_absent', checkedAt: 5 }, { status: 'effect_absent', checkedAt: 500 }, { status: 'unreachable' },
    ];
    for (let run = 0; run < 3000; run++) {
      let state: ApplicationState = startApplication(BASE);
      const effects: ApplicationEffect[] = [];
      let sawMatched = false;
      for (let i = 0; i < 14; i++) {
        const k = rnd(4);
        const at = 10 + i * 20;
        const event: ApplicationEvent = k === 0 ? { type: 'begin_apply', attemptKey: ['a1', 'a2'][rnd(2)]!, at }
          : k === 1 ? (() => { const o = observations[rnd(observations.length)]!; if (o.status === 'effect_present' && o === matched) sawMatched = true; return { type: 'provider_observation', attemptKey: ['a1', 'a2'][rnd(2)]!, observation: o, at } as ApplicationEvent; })()
            : k === 2 ? { type: 'reverse', reversalRef: ['r1', 'r2', 'r3'][rnd(3)]!, at } : { type: 'release_unused', at };
        const r = transition(state, event);
        if (r.ok) { state = r.state; effects.push(...r.effects); }
      }
      const consumes = effects.filter(e => e.type === 'consume').length;
      const releases = effects.filter(e => e.type === 'release').length;
      const comps = effects.filter((e): e is Extract<ApplicationEffect, { type: 'append_compensation' }> => e.type === 'append_compensation');
      expect(consumes).toBeLessThanOrEqual(1);
      if (consumes === 1) { expect(sawMatched).toBe(true); expect(releases).toBe(0); expect(state.kind).toBe('consumed'); }
      expect(releases).toBeLessThanOrEqual(1);
      expect(new Set(comps.map(c => c.idempotencyKey)).size).toBe(comps.length);
      if (comps.length > 0) expect(consumes).toBe(1);
      if (releases === 1) expect(state.kind).toBe('released');
      for (const c of comps) { expect(c.units).toBe(-3); expect(c.benefitMinor).toBe(-300); }
    }
  });
});
