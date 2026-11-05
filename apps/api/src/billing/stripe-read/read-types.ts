import type { AuditEventName, FailureClass, ReadMethodId } from './capability-registry';
import type { NormalizedStripeEvidence } from './evidence-types';
import type { NormalizeDenial } from './invoice-normalizer';

/**
 * Shared outcome and audit types of the read path. The audit sink receives codes, method ids and identifiers only: never a response body, a header, a credential or a URL.
 */
export interface ReadAuditEvent {
  readonly event: AuditEventName; readonly methodId: ReadMethodId | 'UNKNOWN'; readonly reason: string | null;
  readonly businessId: string | null; readonly invoiceId: string | null; readonly atMs: number;
  /** Where the read was served from. Absent on events emitted before a provider was chosen. */
  readonly origin?: 'STRIPE_TEST_READ' | 'MOCK_FIXTURE';
}
export type AuditSink = (event: ReadAuditEvent) => void;

export type AcquireDenial =
  | 'UNKNOWN_METHOD' | 'METHOD_NOT_AUTHORIZED' | 'AUTHORIZATION_MISSING' | 'AUTHORIZATION_INVALID' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REVOKED' | 'METHOD_NOT_APPROVED' | 'REALM_NOT_TEST' | 'ACCOUNT_NOT_APPROVED'
  | 'ACCOUNT_MISMATCH' | 'ACCOUNT_RESPONSE_INVALID' | 'INVALID_REQUEST' | 'UNSUPPORTED_API_VERSION' | NormalizeDenial;
export type AcquireOutcome =
  | Readonly<{ ok: true; evidence: NormalizedStripeEvidence }>
  | Readonly<{ ok: false; kind: 'DENIED'; reason: AcquireDenial }>
  | Readonly<{ ok: false; kind: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;

/** An emitter that can never throw into the read path and stamps the trusted clock. */
export function makeEmitter(audit: AuditSink, clock: () => number, origin?: ReadAuditEvent['origin']) {
  return (event: AuditEventName, methodId: ReadMethodId | 'UNKNOWN', reason: string | null, scope: { businessId?: string; invoiceId?: string } | null): void => {
    try { audit({ event, methodId, reason, businessId: scope?.businessId ?? null, invoiceId: scope?.invoiceId ?? null, atMs: clock(), ...(origin ? { origin } : {}) }); } catch { /* an audit failure never changes a decision */ }
  };
}
