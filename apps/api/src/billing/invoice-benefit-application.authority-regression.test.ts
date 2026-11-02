import { describe, expect, it } from 'vitest';
import { startApplication, transition, type ApplicationBase, type ProviderObservation } from './invoice-benefit-application.saga';

const base: ApplicationBase = {
  reservationRef: 'reservation-1', businessId: 'business-1', invoiceRef: 'invoice-1',
  units: 2, expectedBenefitMinor: 199, currency: 'usd', policyVersion: 'PC-BENEFIT/1',
};

function applyObservation(observation: ProviderObservation) {
  const reserved = startApplication(base);
  const begun = transition(reserved, { type: 'begin_apply', attemptKey: 'reservation-attempt', at: 100 });
  expect(begun.ok).toBe(true);
  if (!begun.ok) throw new Error('begin_apply unexpectedly rejected');
  return transition(begun.state, { type: 'provider_observation', attemptKey: 'reservation-attempt', observation, at: 200 });
}

describe('Split 08 benefit provider authority regression (pure, no Stripe or DB effects)', () => {
  it.each([
    ['missing attribution', null, 'invoice-1', 'usd', 199, 'PROVIDER_EFFECT_UNATTRIBUTED'],
    ['foreign reservation', 'reservation-2', 'invoice-1', 'usd', 199, 'PROVIDER_EFFECT_MISMATCH'],
    ['different invoice', 'reservation-1', 'invoice-2', 'usd', 199, 'PROVIDER_EFFECT_MISMATCH'],
    ['different currency', 'reservation-1', 'invoice-1', 'eur', 199, 'PROVIDER_EFFECT_MISMATCH'],
    ['different benefit', 'reservation-1', 'invoice-1', 'usd', 198, 'PROVIDER_EFFECT_MISMATCH'],
  ] as const)('%s never authorizes consumption', (_name, attribution, invoiceRef, currency, amountMinor, cause) => {
    const result = applyObservation({
      status: 'effect_present', effectRef: 'effect-1', attributedToReservationRef: attribution,
      invoiceRef, currency, amountMinor,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({ kind: 'retained', cause });
    expect(result.effects.every(effect => effect.type !== 'consume' && effect.type !== 'release')).toBe(true);
  });

  it('unreachable provider cannot produce consumption or release', () => {
    const result = applyObservation({ status: 'unreachable' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toMatchObject({ kind: 'retained', cause: 'PROVIDER_UNREACHABLE' });
    expect(result.effects).toEqual([{ type: 'flag_for_reconciliation', reservationRef: base.reservationRef, cause: 'PROVIDER_UNREACHABLE' }]);
  });

  it('an exact match alone produces one declarative consume effect and no release', () => {
    const result = applyObservation({
      status: 'effect_present', effectRef: 'effect-1', attributedToReservationRef: base.reservationRef,
      invoiceRef: base.invoiceRef, currency: base.currency, amountMinor: base.expectedBenefitMinor,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.kind).toBe('consumed');
    expect(result.effects).toEqual([{
      type: 'consume', reservationRef: base.reservationRef, units: base.units,
      providerEffectRef: 'effect-1', benefitMinor: base.expectedBenefitMinor,
    }]);
  });
});
