/**
 * CE-1 is a proposed cross-domain boundary, NOT an activated billing contract.
 * Split 08 must authoritatively persist and expose these facts before a
 * consumed-credit reversal can become legal.
 */
export interface PartnerConsumptionProofCandidate {
  evidenceVersion: 'partner-consumption/1';
  applicationRef: string;
  reservationRef: string;
  invoiceRef: string;
  businessId: string;
  decisionId: string;
  lotId: string;
  unitsApplied: number;
  applicationState: 'applied';
  appliedAt: string;
}

/**
 * Human-facing or transport-layer data is categorically insufficient evidence
 * of Split 08 consumption. The verified database adapter is intentionally
 * absent until the Split 08 contract and its source are frozen.
 */
export function rejectUnverifiedConsumptionEvidence(_candidate: unknown): never {
  throw new Error('PARTNER_CONSUMPTION_AUTHORITY_NOT_ESTABLISHED');
}

export interface PartnerCreditConservationSnapshot {
  account: { provisional: number; available: number; reserved: number; recoveryDue: number };
  lots: ReadonlyArray<{
    id: string;
    units: number;
    availableUnits: number;
    status: 'provisional' | 'available' | 'reserved' | 'consumed' | 'expired' | 'reversed';
  }>;
  obligations: ReadonlyArray<{ unitsDue: number; unitsOutstanding: number }>;
}

/**
 * A read-only, pre-Split08 reconciliation gate for supported unreserved lots.
 * 'consumed' and 'reserved' remain unsupported without immutable Split 08
 * allocation evidence: NEVER classify either as conserved by assumption.
 * Recovery-offset consumption also requires its own persisted ledger check.
 */
export function inspectPartnerCreditConservation(
  snapshot: PartnerCreditConservationSnapshot,
): { valid: boolean; violations: string[] } {
  const violations: string[] = [];
  const accountValues = Object.values(snapshot.account);
  if (accountValues.some(x => !Number.isSafeInteger(x) || x < 0)) {
    violations.push('PARTNER_ACCOUNT_INVALID_BUCKET');
  }
  const seen = new Set<string>();
  let provisional = 0;
  let available = 0;
  for (const lot of snapshot.lots) {
    if (!lot.id || seen.has(lot.id)) violations.push('PARTNER_LOT_ID_DUPLICATE');
    seen.add(lot.id);
    if (!Number.isSafeInteger(lot.units) || lot.units <= 0 ||
        !Number.isSafeInteger(lot.availableUnits) || lot.availableUnits < 0 ||
        lot.availableUnits > lot.units) {
      violations.push('PARTNER_LOT_INVALID_QUANTITY');
      continue;
    }
    if (lot.status === 'provisional') {
      if (lot.availableUnits !== 0) violations.push('PARTNER_PROVISIONAL_LOT_EXPOSES_AVAILABLE');
      provisional += lot.units;
    } else if (lot.status === 'available') {
      if (lot.availableUnits !== lot.units) violations.push('PARTNER_AVAILABLE_LOT_INCOMPLETE');
      available += lot.availableUnits;
    } else if (lot.status === 'reserved' || lot.status === 'consumed') {
      violations.push('PARTNER_CONSUMPTION_ALLOCATION_AUTHORITY_MISSING');
    } else if (lot.availableUnits !== 0) {
      violations.push('PARTNER_TERMINAL_LOT_HAS_AVAILABLE');
    }
  }
  if (snapshot.account.reserved !== 0) {
    violations.push('PARTNER_RESERVED_BUCKET_REQUIRES_SPLIT08_AUTHORITY');
  }
  if (snapshot.account.provisional !== provisional) {
    violations.push('PARTNER_PROVISIONAL_PROJECTION_MISMATCH');
  }
  if (snapshot.account.available !== available) {
    violations.push('PARTNER_AVAILABLE_PROJECTION_MISMATCH');
  }
  let due = 0;
  for (const obligation of snapshot.obligations) {
    if (!Number.isSafeInteger(obligation.unitsDue) || obligation.unitsDue <= 0 ||
        !Number.isSafeInteger(obligation.unitsOutstanding) ||
        obligation.unitsOutstanding < 0 || obligation.unitsOutstanding > obligation.unitsDue) {
      violations.push('PARTNER_RECOVERY_OBLIGATION_INVALID');
    } else {
      due += obligation.unitsOutstanding;
    }
  }
  if (!Number.isSafeInteger(due) || snapshot.account.recoveryDue !== due) {
    violations.push('PARTNER_RECOVERY_PROJECTION_MISMATCH');
  }
  return { valid: violations.length === 0, violations: [...new Set(violations)] };
}
