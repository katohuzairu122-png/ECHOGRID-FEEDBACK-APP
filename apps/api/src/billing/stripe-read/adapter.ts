import { decideCapability, type AuditEventName, type FailureClass, type ReadAuthorization, type ReadMethodId } from './capability-registry';
import { normalizeInvoice, type NormalizeDenial, type TrustedInvoiceScope } from './invoice-normalizer';
import { assembleEvidence, NO_REAL_MAPPING } from './bundle-builder';
import { sealBundle } from './evidence-origin';
import { verified, type NormalizedStripeEvidence } from './evidence-types';
import { ProviderReadError, STRIPE_API_VERSION, type StripeReadTransport } from './transport';
import { profileFor } from './provider-profiles';

/**
 * S08-D1D3-DEV-06: the read-only Stripe evidence adapter. One purpose-built operation, `acquire`: confirm the account, read the invoice twice (bracketing reads), normalize, and
 * return sealed evidence. It has no generic request method, no write method and no way to name another endpoint.
 *
 * The audit sink receives codes, method ids and identifiers only. It never receives a response body, a header, a credential or a URL.
 */
export interface ReadAuditEvent { readonly event: AuditEventName; readonly methodId: ReadMethodId | 'UNKNOWN'; readonly reason: string | null; readonly businessId: string | null; readonly invoiceId: string | null; readonly atMs: number }
export type AuditSink = (event: ReadAuditEvent) => void;

export type AcquireDenial =
  | 'UNKNOWN_METHOD' | 'METHOD_NOT_AUTHORIZED' | 'AUTHORIZATION_MISSING' | 'AUTHORIZATION_INVALID' | 'AUTHORIZATION_EXPIRED' | 'AUTHORIZATION_REVOKED' | 'METHOD_NOT_APPROVED' | 'REALM_NOT_TEST' | 'ACCOUNT_NOT_APPROVED'
  | 'ACCOUNT_MISMATCH' | 'ACCOUNT_RESPONSE_INVALID' | 'INVALID_REQUEST' | 'UNSUPPORTED_API_VERSION' | NormalizeDenial;
export type AcquireOutcome =
  | Readonly<{ ok: true; evidence: NormalizedStripeEvidence }>
  | Readonly<{ ok: false; kind: 'DENIED'; reason: AcquireDenial }>
  | Readonly<{ ok: false; kind: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;

const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,159}$/;

export class StripeReadOnlyEvidenceAdapter {
  constructor(private readonly deps: Readonly<{ transport: StripeReadTransport; authorization: ReadAuthorization | null; clock: () => number; audit: AuditSink; /** The API version the transport reads with; defaults to the pinned one. A version with no mapping profile is refused. */ apiVersion?: string }>) {}

  private emit(event: AuditEventName, methodId: ReadMethodId | 'UNKNOWN', reason: string | null, scope: { businessId?: string; invoiceId?: string } | null): void {
    try { this.deps.audit({ event, methodId, reason, businessId: scope?.businessId ?? null, invoiceId: scope?.invoiceId ?? null, atMs: this.deps.clock() }); } catch { /* an audit failure never changes the decision */ }
  }

  async acquire(scope: TrustedInvoiceScope): Promise<AcquireOutcome> {
    const audit = { businessId: scope?.businessId, invoiceId: scope?.invoiceId };
    if (!scope || !TOKEN.test(String(scope.businessId)) || !INVOICE_ID.test(String(scope.invoiceId)) || !TOKEN.test(String(scope.customerId)) || !TOKEN.test(String(scope.subscriptionId))) {
      this.emit('stripe_read.denied', 'UNKNOWN', 'INVALID_REQUEST', null);
      return { ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' };
    }
    if (profileFor(this.deps.apiVersion ?? STRIPE_API_VERSION) === null) { this.emit('stripe_read.denied', 'UNKNOWN', 'UNSUPPORTED_API_VERSION', audit); return { ok: false, kind: 'DENIED', reason: 'UNSUPPORTED_API_VERSION' }; }
    const now = this.deps.clock();
    for (const id of ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as const) {
      const d = decideCapability(id, this.deps.authorization, now);
      if (!d.allowed) { this.emit('stripe_read.denied', id, d.reason, audit); return { ok: false, kind: 'DENIED', reason: d.reason }; }
    }
    const auth = this.deps.authorization as ReadAuthorization;
    const fail = (id: ReadMethodId, e: unknown): AcquireOutcome => {
      const failureClass = e instanceof ProviderReadError ? e.failureClass : 'NETWORK';
      this.emit('stripe_read.failure', id, failureClass, audit);
      return { ok: false, kind: 'PROVIDER_FAILURE', failureClass };
    };

    // 1. the account the credential belongs to must be the approved one, before any invoice is requested
    let account: unknown;
    this.emit('stripe_read.attempt', 'ACCOUNT_RETRIEVE_CURRENT', null, audit);
    try { account = await this.deps.transport.get('ACCOUNT_RETRIEVE_CURRENT'); } catch (e) { return fail('ACCOUNT_RETRIEVE_CURRENT', e); }
    const acct = account as { object?: unknown; id?: unknown } | null;
    if (!acct || typeof acct !== 'object' || acct.object !== 'account' || typeof acct.id !== 'string') { this.emit('stripe_read.denied', 'ACCOUNT_RETRIEVE_CURRENT', 'ACCOUNT_RESPONSE_INVALID', audit); return { ok: false, kind: 'DENIED', reason: 'ACCOUNT_RESPONSE_INVALID' }; }
    if (acct.id !== auth.accountId) { this.emit('stripe_read.denied', 'ACCOUNT_RETRIEVE_CURRENT', 'ACCOUNT_MISMATCH', audit); return { ok: false, kind: 'DENIED', reason: 'ACCOUNT_MISMATCH' }; }
    this.emit('stripe_read.success', 'ACCOUNT_RETRIEVE_CURRENT', null, audit);

    // 2. the invoice, read before and after (the bracketing reads the classifier requires), each independently normalized
    const reads: Array<{ raw: unknown }> = [];
    for (let i = 0; i < 2; i++) {
      this.emit('stripe_read.attempt', 'INVOICE_RETRIEVE', null, audit);
      try { reads.push({ raw: await this.deps.transport.get('INVOICE_RETRIEVE', { invoiceId: scope.invoiceId }) }); } catch (e) { return fail('INVOICE_RETRIEVE', e); }
    }
    const observedAtMs = this.deps.clock(); // the trusted server clock, taken after the reads; never copied from a response
    const [a, b] = reads.map(r => normalizeInvoice(r.raw, scope, observedAtMs, 'STRIPE_TEST_READ'));
    for (const n of [a!, b!]) if (n.denied) { this.emit('stripe_read.denied', 'INVOICE_RETRIEVE', n.denied, audit); return { ok: false, kind: 'DENIED', reason: n.denied }; }
    if (a!.denied !== null || b!.denied !== null) return { ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' };
    this.emit('stripe_read.success', 'INVOICE_RETRIEVE', null, audit);

    const evidence = await assembleEvidence({
      origin: 'STRIPE_TEST_READ', observedAtMs, requested: { businessId: scope.businessId, invoiceId: scope.invoiceId, expectedAccountId: auth.accountId },
      accountId: verified(acct.id, 'STRIPE_TEST_READ', 'PROVIDER_SCHEMA'),
      // test mode is proven by BOTH the credential's mode (fixed 'test' at construction) and livemode=false on the invoice (a true value was a denial above)
      mode: verified('test' as const, 'STRIPE_TEST_READ', 'PROVIDER_SCHEMA'),
      facts: a!.facts, factsAfter: b!.facts, fingerprintBefore: a!.fingerprint, fingerprintAfter: b!.fingerprint, invoiceContradictions: a!.contradictions,
      ...NO_REAL_MAPPING,
    });
    return { ok: true, evidence: sealBundle(evidence, 'STRIPE_TEST_READ') };
  }
}
