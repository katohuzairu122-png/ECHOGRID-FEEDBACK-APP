import { authorizePrivateInvocation, type InvocationDependencies, type InvocationPolicy, type InvocationRequest } from '../private-stripe-verifier-invocation.contract';
import { assertsAuthority } from '../settlement-eligibility.classifier';
import type { AcquireDenial, StripeReadOnlyEvidenceAdapter } from './adapter';
import type { FailureClass } from './capability-registry';
import type { NormalizedStripeEvidence } from './evidence-types';
import type { TrustedInvoiceScope } from './invoice-normalizer';

/**
 * S08-D1D3-DEV-06: the trusted evidence authority. It sits INSIDE the private verifier boundary (the adapter it wraps holds the only provider transport) and is the only thing
 * that turns a request into provider evidence. It does not authenticate callers itself: it enforces the existing S08-PV05 invocation contract (a request-bound proof checked by an
 * injected authenticator, an approved policy, audience, inventory revision, method list, trusted invoice scope, lifetime and single-use nonce) for BOTH provider operations before
 * any provider call.
 *
 * What a caller may send: a business id and an invoice id (plus the invocation proofs). That is all. A request that carries any other property, in particular a verdict,
 * completeness flag, mode, account or "verified"/"authorized" assertion, is refused. The tenant binding (customer, subscription) comes from `resolveScope`, which reads persisted,
 * tenant-checked records; an invoice that does not belong to the tenant resolves to nothing and is refused as a tenant mismatch.
 *
 * Not wired to any route, queue, Worker handler or cron. The private verifier Worker remains an inert 404 handler until its execution is separately authorized.
 */
export interface EvidenceRequest { readonly businessId: string; readonly invoiceId: string }
export interface InvocationPair<Proof> {
  readonly account: Readonly<{ request: InvocationRequest; proof: Proof }>;
  readonly invoice: Readonly<{ request: InvocationRequest; proof: Proof }>;
}
export type EvidenceResult =
  | Readonly<{ status: 'OK'; evidence: NormalizedStripeEvidence }>
  | Readonly<{ status: 'DENIED'; reason: ServiceDenial }>
  | Readonly<{ status: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;
export type ServiceDenial =
  | 'INVALID_REQUEST' | 'CALLER_ASSERTION_REFUSED' | 'TENANT_MISMATCH' | 'SCOPE_MISMATCH' | 'DEPENDENCY_UNAVAILABLE'
  | 'INVOCATION_INVALID_REQUEST' | 'INVOCATION_AUTHENTICATION_FAILED' | 'INVOCATION_CALLER_NOT_APPROVED' | 'INVOCATION_TARGET_MISMATCH' | 'INVOCATION_SCOPE_MISMATCH'
  | 'INVOCATION_APPROVAL_EXPIRED' | 'INVOCATION_REPLAY_REJECTED' | 'INVOCATION_DEPENDENCY_UNAVAILABLE' | AcquireDenial;

const ALLOWED_KEYS: ReadonlySet<string> = new Set(['businessId', 'invoiceId']);

export class TrustedStripeEvidenceService<Proof> {
  constructor(private readonly d: Readonly<{
    adapter: StripeReadOnlyEvidenceAdapter;
    policy: InvocationPolicy | null;
    invocation: InvocationDependencies<Proof>;
    /** Persisted, tenant-checked binding of (business, invoice) to customer and subscription; null when the invoice is not that tenant's. */
    resolveScope: (businessId: string, invoiceId: string) => Promise<TrustedInvoiceScope | null>;
    clock: () => number;
  }>) {}

  async readInvoiceEvidence(request: EvidenceRequest, invocations: InvocationPair<Proof>): Promise<EvidenceResult> {
    try {
      if (!request || typeof request !== 'object' || typeof request.businessId !== 'string' || typeof request.invoiceId !== 'string') return { status: 'DENIED', reason: 'INVALID_REQUEST' };
      if (Object.keys(request).some(k => !ALLOWED_KEYS.has(k)) || assertsAuthority(request)) return { status: 'DENIED', reason: 'CALLER_ASSERTION_REFUSED' };
      let scope: TrustedInvoiceScope | null;
      try { scope = await this.d.resolveScope(request.businessId, request.invoiceId); } catch { return { status: 'DENIED', reason: 'DEPENDENCY_UNAVAILABLE' }; }
      if (!scope || scope.businessId !== request.businessId || scope.invoiceId !== request.invoiceId) return { status: 'DENIED', reason: 'TENANT_MISMATCH' };
      const inv = invocations?.invoice?.request; const acc = invocations?.account?.request;
      if (!inv || !acc || acc.operation !== 'GET /v1/account' || inv.operation !== 'GET /v1/invoices/{id}') return { status: 'DENIED', reason: 'INVALID_REQUEST' };
      const s = inv.invoiceScope;
      if (!s || s.invoiceId !== scope.invoiceId || s.businessId !== scope.businessId || s.customerId !== scope.customerId || s.subscriptionId !== scope.subscriptionId) return { status: 'DENIED', reason: 'SCOPE_MISMATCH' };

      const now = this.d.clock();
      for (const pair of [invocations.account, invocations.invoice]) {
        const decision = await authorizePrivateInvocation(pair.request, pair.proof, this.d.policy, this.d.invocation, now);
        if (!decision.allowed) return { status: 'DENIED', reason: `INVOCATION_${decision.reason}` as ServiceDenial & `INVOCATION_${string}` };
      }
      const out = await this.d.adapter.acquire(scope);
      if (out.ok) return { status: 'OK', evidence: out.evidence };
      return out.kind === 'DENIED' ? { status: 'DENIED', reason: out.reason } : { status: 'PROVIDER_FAILURE', failureClass: out.failureClass };
    } catch {
      return { status: 'DENIED', reason: 'DEPENDENCY_UNAVAILABLE' }; // nothing thrown here ever reaches a caller with detail
    }
  }
}
