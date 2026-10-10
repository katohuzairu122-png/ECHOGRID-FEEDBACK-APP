/**
 * Split 08 CE-1 contract candidate. PURE and INERT.
 *
 * This module is not proof of Stripe/invoice success. Only a separately
 * implemented trusted Split 08 database adapter can establish that proof.
 * No handler, worker, or billing route may call a consumption writer until
 * the authoritative persistence and provider reconciliation are frozen.
 */
export type ReservationState =
  | 'reserved'
  | 'released'
  | 'consumed';

export interface ReservedPartnerCredit {
  reservationRef: string;
  businessId: string;
  decisionId: string;
  lotId: string;
  invoiceIntentRef: string;
  units: 1;
  state: ReservationState;
  expiresAt: string;
}

export interface TerminalCreditApplicationEvidence {
  evidenceVersion: 'partner-consumption/1';
  applicationRef: string;
  reservationRef: string;
  invoiceRef: string;
  subscriptionRef: string;
  businessId: string;
  decisionId: string;
  lotId: string;
  unitsApplied: 1;
  providerSuccessRef: string;
  appliedAt: string;
  terminalState: 'applied';
}

export type TrustedApplicationLookup =
  | { kind: 'not_found' }
  | { kind: 'not_terminal' }
  | { kind: 'verified'; evidence: TerminalCreditApplicationEvidence };

/** A validated terminal record is necessary, but only a trusted
 * application-lookup adapter may produce TrustedApplicationLookup.
 * This pure comparison must NOT be used with client-produced lookups.
 */
export function assertMatchingTerminalApplication(
  reservation: ReservedPartnerCredit,
  source: TrustedApplicationLookup,
  now: Date,
): TerminalCreditApplicationEvidence {
  if (source.kind !== 'verified')
    throw new Error('SPLIT08_TERMINAL_APPLICATION_NOT_VERIFIED');
  if (reservation.state !== 'reserved' || reservation.units !== 1)
    throw new Error('SPLIT08_RESERVATION_NOT_ACTIVE');
  const evidence = source.evidence;
  if (evidence.evidenceVersion !== 'partner-consumption/1' ||
      evidence.terminalState !== 'applied' ||
      !evidence.applicationRef || !evidence.invoiceRef ||
      !evidence.subscriptionRef || !evidence.providerSuccessRef ||
      !Number.isFinite(Date.parse(evidence.appliedAt)) ||
      !Number.isFinite(Date.parse(reservation.expiresAt)) ||
      !Number.isFinite(now.getTime()))
    throw new Error('SPLIT08_TERMINAL_EVIDENCE_INVALID');
  if (evidence.reservationRef !== reservation.reservationRef ||
      evidence.businessId !== reservation.businessId ||
      evidence.decisionId !== reservation.decisionId ||
      evidence.lotId !== reservation.lotId ||
      evidence.unitsApplied !== reservation.units)
    throw new Error('SPLIT08_CREDIT_ALLOCATION_MISMATCH');
  if (Date.parse(evidence.appliedAt) > now.getTime() ||
      Date.parse(evidence.appliedAt) > Date.parse(reservation.expiresAt))
    throw new Error('SPLIT08_TERMINAL_APPLICATION_OUTSIDE_RESERVATION');
  return evidence;
}

export function assertReservationTransition(
  from: ReservationState, to: ReservationState,
): void {
  const allowed = from === 'reserved' && (to === 'released' || to === 'consumed');
  if (!allowed) throw new Error('SPLIT08_RESERVATION_TRANSITION_DENIED');
}

/** Must never be used as a successful proof source: the adapter is not built. */
export function unresolvedTerminalApplication(): TrustedApplicationLookup {
  return {kind: 'not_found'};
}
