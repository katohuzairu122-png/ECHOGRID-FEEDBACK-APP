/**
 * Split 08 benefit-application saga: a PURE state machine for the lifecycle of one Partner Credit reservation being applied to one invoice.
 *
 * Stripe and PostgreSQL are not one atomic transaction, so consumption is only ever the RESULT of a reconciled provider observation, never of a
 * caller assertion. This module decides transitions and describes the database movements that would follow as declarative `effects`; it performs
 * none of them, calls no provider, and authorizes nothing. Replays are idempotent; terminal states are absorbing, except that a reversal after
 * consumption appends exactly one compensating entry per reversal reference (history is never edited).
 *
 * Owner rules (2026-10-23): consumption requires confirmed provider-side application; a failed application is reconciled and then released or
 * retained; reversals append compensating entries; no retroactive adjustment.
 */
export interface ApplicationBase {
  reservationRef: string;
  businessId: string;
  invoiceRef: string;
  units: number;
  expectedBenefitMinor: number;
  currency: string;
  policyVersion: string;
}

export type RetainCause = 'PROVIDER_UNREACHABLE' | 'PROVIDER_EFFECT_MISMATCH' | 'PROVIDER_EFFECT_UNATTRIBUTED' | 'STALE_ABSENCE' | 'REVERSAL_DURING_APPLICATION';
export type ReleaseCause = 'PROVIDER_CONFIRMED_NO_EFFECT' | 'REVERSED_BEFORE_APPLICATION' | 'RESERVATION_UNUSED';

export type ApplicationState =
  | ({ kind: 'reserved' } & ApplicationBase)
  | ({ kind: 'applying'; attemptKey: string; attemptedAt: number } & ApplicationBase)
  | ({ kind: 'retained'; attemptKey: string; attemptedAt: number; cause: RetainCause; pendingReversalRefs: readonly string[] } & ApplicationBase)
  | ({ kind: 'consumed'; providerEffectRef: string; appliedAt: number; compensations: readonly string[] } & ApplicationBase)
  | ({ kind: 'released'; cause: ReleaseCause } & ApplicationBase);

export type ProviderObservation =
  | { status: 'effect_present'; effectRef: string; amountMinor: number; currency: string; invoiceRef: string; attributedToReservationRef: string | null }
  | { status: 'effect_absent'; checkedAt: number }
  | { status: 'unreachable' };

export type ApplicationEvent =
  | { type: 'begin_apply'; attemptKey: string; at: number }
  | { type: 'provider_observation'; attemptKey: string; observation: ProviderObservation; at: number }
  | { type: 'reverse'; reversalRef: string; at: number }
  | { type: 'release_unused'; at: number };

export type ApplicationEffect =
  | { type: 'consume'; reservationRef: string; units: number; providerEffectRef: string; benefitMinor: number }
  | { type: 'release'; reservationRef: string; units: number; cause: ReleaseCause }
  | { type: 'append_compensation'; reservationRef: string; units: number; benefitMinor: number; reversalRef: string; idempotencyKey: string }
  | { type: 'flag_for_reconciliation'; reservationRef: string; cause: RetainCause };

export type RejectCode = 'ATTEMPT_CONFLICT' | 'ATTEMPT_MISMATCH' | 'INVALID_TRANSITION' | 'INVALID_INPUT';

export type TransitionResult =
  | { ok: true; state: ApplicationState; effects: ApplicationEffect[]; replay: boolean }
  | { ok: false; code: RejectCode; state: ApplicationState };

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const text = (s: unknown): s is string => typeof s === 'string' && s.trim().length > 0;

export type EffectClass = 'matched' | 'mismatch' | 'unattributed';
/** A present provider effect is only a match when it is attributed to THIS reservation, on THIS invoice, in the expected currency, for exactly the expected amount. */
export function classifyPresentEffect(base: ApplicationBase, o: Extract<ProviderObservation, { status: 'effect_present' }>): EffectClass {
  if (!text(o.effectRef) || o.attributedToReservationRef === null) return 'unattributed';
  if (o.attributedToReservationRef !== base.reservationRef || o.invoiceRef !== base.invoiceRef) return 'mismatch';
  if (o.currency !== base.currency || o.amountMinor !== base.expectedBenefitMinor) return 'mismatch';
  return 'matched';
}

function compensation(b: ApplicationBase, reversalRef: string): ApplicationEffect {
  return { type: 'append_compensation', reservationRef: b.reservationRef, units: -b.units, benefitMinor: -b.expectedBenefitMinor, reversalRef, idempotencyKey: `benefit-compensation:v1:${b.reservationRef}:${reversalRef}` };
}

export function startApplication(base: ApplicationBase): ApplicationState {
  if (!text(base.reservationRef) || !text(base.businessId) || !text(base.invoiceRef) || !Number.isSafeInteger(base.units) || base.units < 1 ||
      !Number.isSafeInteger(base.expectedBenefitMinor) || base.expectedBenefitMinor < 1 || !/^[a-z]{3}$/.test(base.currency) || !text(base.policyVersion))
    throw new Error('APPLICATION_BASE_INVALID');
  return { kind: 'reserved', ...base };
}

const base = (s: ApplicationState): ApplicationBase => ({
  reservationRef: s.reservationRef, businessId: s.businessId, invoiceRef: s.invoiceRef, units: s.units,
  expectedBenefitMinor: s.expectedBenefitMinor, currency: s.currency, policyVersion: s.policyVersion,
});

export function transition(state: ApplicationState, event: ApplicationEvent): TransitionResult {
  const reject = (code: RejectCode): TransitionResult => ({ ok: false, code, state });
  const ok = (next: ApplicationState, effects: ApplicationEffect[] = [], replay = false): TransitionResult => ({ ok: true, state: next, effects, replay });
  if (!event || !finite((event as { at?: unknown }).at)) return reject('INVALID_INPUT');

  switch (event.type) {
    case 'begin_apply': {
      if (!text(event.attemptKey)) return reject('INVALID_INPUT');
      if (state.kind === 'reserved') return ok({ ...state, kind: 'applying', attemptKey: event.attemptKey, attemptedAt: event.at });
      if ((state.kind === 'applying' || state.kind === 'retained') && state.attemptKey === event.attemptKey) return ok(state, [], true);
      if (state.kind === 'applying' || state.kind === 'retained') return reject('ATTEMPT_CONFLICT'); // never run a second provider attempt for one reservation
      return reject('INVALID_TRANSITION');
    }
    case 'provider_observation': {
      if (state.kind === 'consumed' || state.kind === 'released') return ok(state, [], true); // replayed or late observation: terminal states absorb it
      if (state.kind === 'reserved') return reject('INVALID_TRANSITION');
      if (!text(event.attemptKey)) return reject('INVALID_INPUT');
      if (event.attemptKey !== state.attemptKey) return reject('ATTEMPT_MISMATCH');
      const o = event.observation;
      const pending = state.kind === 'retained' ? state.pendingReversalRefs : [];
      const retain = (cause: RetainCause): TransitionResult => {
        const same = state.kind === 'retained' && state.cause === cause;
        return ok({ ...base(state), kind: 'retained', attemptKey: state.attemptKey, attemptedAt: state.attemptedAt, cause, pendingReversalRefs: pending }, same ? [] : [{ type: 'flag_for_reconciliation', reservationRef: state.reservationRef, cause }], same);
      };
      if (!o || typeof o !== 'object') return reject('INVALID_INPUT');
      if (o.status === 'unreachable') return retain('PROVIDER_UNREACHABLE');
      if (o.status === 'effect_absent') {
        if (!finite(o.checkedAt)) return reject('INVALID_INPUT');
        // Absence only counts if the provider was queried AFTER the attempt started; an earlier look says nothing about the attempt.
        if (o.checkedAt < state.attemptedAt) return retain('STALE_ABSENCE');
        return ok({ ...base(state), kind: 'released', cause: 'PROVIDER_CONFIRMED_NO_EFFECT' }, [{ type: 'release', reservationRef: state.reservationRef, units: state.units, cause: 'PROVIDER_CONFIRMED_NO_EFFECT' }]);
      }
      if (o.status !== 'effect_present' || !Number.isSafeInteger(o.amountMinor) || o.amountMinor < 0 || !text(o.currency) || !text(o.invoiceRef)) return reject('INVALID_INPUT');
      const cls = classifyPresentEffect(state, o);
      if (cls === 'unattributed') return retain('PROVIDER_EFFECT_UNATTRIBUTED');
      if (cls === 'mismatch') return retain('PROVIDER_EFFECT_MISMATCH');
      // Reversals that arrived while the provider outcome was unknown now apply to the (confirmed) consumption: one compensating entry each.
      return ok({ ...base(state), kind: 'consumed', providerEffectRef: o.effectRef, appliedAt: event.at, compensations: pending },
        [{ type: 'consume', reservationRef: state.reservationRef, units: state.units, providerEffectRef: o.effectRef, benefitMinor: state.expectedBenefitMinor },
          ...pending.map((ref): ApplicationEffect => compensation(state, ref))]);
    }
    case 'reverse': {
      if (!text(event.reversalRef)) return reject('INVALID_INPUT');
      if (state.kind === 'reserved') return ok({ ...base(state), kind: 'released', cause: 'REVERSED_BEFORE_APPLICATION' }, [{ type: 'release', reservationRef: state.reservationRef, units: state.units, cause: 'REVERSED_BEFORE_APPLICATION' }]);
      if (state.kind === 'released') return ok(state, [], true);
      if (state.kind === 'applying' || state.kind === 'retained') {
        // A provider effect may exist: never release (could re-grant a credit whose discount was applied). Hold for reconciliation.
        const known = state.kind === 'retained' ? state.pendingReversalRefs : [];
        if (known.includes(event.reversalRef)) return ok(state, [], true);
        const cause: RetainCause = state.kind === 'retained' ? state.cause : 'REVERSAL_DURING_APPLICATION';
        return ok({ ...base(state), kind: 'retained', attemptKey: state.attemptKey, attemptedAt: state.attemptedAt, cause, pendingReversalRefs: [...known, event.reversalRef] },
          known.length === 0 && !(state.kind === 'retained') ? [{ type: 'flag_for_reconciliation', reservationRef: state.reservationRef, cause }] : []);
      }
      if (state.compensations.includes(event.reversalRef)) return ok(state, [], true);
      // The consumed row and the historical invoice effect stay untouched; a negative entry is appended once per reversal reference.
      return ok({ ...state, compensations: [...state.compensations, event.reversalRef] }, [compensation(state, event.reversalRef)]);
    }
    case 'release_unused': {
      if (state.kind === 'reserved') return ok({ ...base(state), kind: 'released', cause: 'RESERVATION_UNUSED' }, [{ type: 'release', reservationRef: state.reservationRef, units: state.units, cause: 'RESERVATION_UNUSED' }]);
      if (state.kind === 'released') return ok(state, [], true);
      return reject('INVALID_TRANSITION'); // an attempted or consumed application is never released by timeout
    }
    default:
      return reject('INVALID_INPUT');
  }
}
