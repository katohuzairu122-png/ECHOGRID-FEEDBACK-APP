import type { ReadGate } from './read-gate';
import { acquireEvidence } from './evidence-engine';
import type { TrustedInvoiceScope } from './invoice-normalizer';
import { createRealReadProvider, type ReadProvider } from './read-provider';
import type { AcquireOutcome, AuditSink } from './read-types';
import type { StripeReadTransport } from './transport';

export type { AcquireDenial, AcquireOutcome, AuditSink, ReadAuditEvent } from './read-types';

/**
 * S08-D1D3-DEV-06 / DEV-08: the read-only Stripe evidence adapter for REAL test-mode reads. One purpose-built operation, `acquire`. It has no generic request method, no write method and no
 * way to name another endpoint. Since DEV-08 it is the real `ReadProvider` (account and invoice only, behind the capability registry and the owner's authorization) driven by the shared
 * evidence engine: the four unauthorized reads are denied at runtime inside the provider, so a real acquisition yields a bundle whose lines, payment, refund and dispute categories are
 * UNRESOLVED, which can never be complete and can never reach a classifier as authentic evidence.
 */
export class StripeReadOnlyEvidenceAdapter {
  readonly kind = 'STRIPE_TEST_READ' as const;
  private readonly provider: ReadProvider;
  constructor(private readonly deps: Readonly<{ transport: StripeReadTransport; gate: ReadGate; /** The approved Stripe test account, from the trusted binding; the authorization records are looked up for it. */ expectedAccountId: string; clock: () => number; audit: AuditSink; /** The API version the transport reads with; defaults to the pinned one. A version with no mapping profile is refused. */ apiVersion?: string }>) {
    this.provider = createRealReadProvider(deps);
  }

  async acquire(scope: TrustedInvoiceScope): Promise<AcquireOutcome> {
    return acquireEvidence({ provider: this.provider, clock: this.deps.clock, audit: this.deps.audit }, scope, this.deps.expectedAccountId, null);
  }
}
