/**
 * DEV-21 read-only provenance verification result contract.
 * This type grants no financial authority, does not activate any writer,
 * and must not be used as the D4 settlement consumption gate.
 */
export type DurableProvenanceStatus =
  | 'VERIFIED'
  | 'UNLINKED'
  | 'INVALID'
  | 'UNAVAILABLE';

export type DurableProvenanceResult = Readonly<{
  status: DurableProvenanceStatus;
  durable: boolean;
  financialAuthorization: 'NOT_GRANTED';
}>;

/** Fail closed unless the entire persisted and cryptographic check passed. */
export function durableProvenanceResult(status: DurableProvenanceStatus): DurableProvenanceResult {
  return Object.freeze({
    status,
    durable: status === 'VERIFIED',
    financialAuthorization: 'NOT_GRANTED' as const,
  });
}
