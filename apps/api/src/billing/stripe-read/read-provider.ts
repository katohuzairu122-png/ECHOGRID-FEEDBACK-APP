import { decideCapability, type FailureClass, type ReadAuthorization, type ReadMethodId } from './capability-registry';
import type { EvidenceOrigin, MockLineAttribution } from './evidence-types';
import type { IdempotencyEvidence } from './line-normalizer';
import type { PageRecord } from './pagination';
import type { PaymentTarget } from './refund-dispute-normalizer';
import { makeEmitter, type AcquireDenial, type AuditSink } from './read-types';
import { ProviderReadError, STRIPE_API_VERSION, type StripeReadTransport } from './transport';
import type { MockPaymentDispute, MockRefund } from '../refund-dispute.classifier';
import type { CancellationEvidence, MockBenefitItem } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-08: the typed provider interface behind the evidence engine. Six reads plus a supplement, each returning an outcome value, never throwing provider detail.
 *
 *  - `createRealReadProvider` serves the two APPROVAL_REQUIRED reads (account, invoice) over the GET-only transport, behind the capability registry and the owner's `ReadAuthorization`.
 *    The four unauthorized reads (lines pagination, payment, refunds, disputes) and the supplement are denied AT RUNTIME: no transport call, no mock substitute. A real read can therefore
 *    never be completed with invented data; its remaining categories stay UNRESOLVED.
 *  - `createMockReadProvider` serves all six from synthetic fixtures. It never touches a network or a credential and its evidence is sealed MOCK_FIXTURE.
 * A provider is never a mixture: real facts and fixture facts are not combined into one bundle.
 */
export type ObjectRead =
  | Readonly<{ ok: true; body: unknown }>
  | Readonly<{ ok: false; kind: 'DENIED'; reason: AcquireDenial }>
  | Readonly<{ ok: false; kind: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;
export type ListRead =
  | Readonly<{ ok: true; pages: readonly PageRecord[] }>
  | Readonly<{ ok: false; kind: 'DENIED'; reason: 'METHOD_NOT_AUTHORIZED' | 'NO_TARGET' }>
  | Readonly<{ ok: false; kind: 'PROVIDER_FAILURE'; failureClass: FailureClass }>;
export type Slot<T> = T | 'absent' | 'unresolved';

/** Categories that need a read nobody has authorized (invoice item, subscription) and the separate idempotency evidence. Real providers return the unresolved/null defaults. */
export interface Supplement {
  readonly billingInterval: 'month' | 'year' | 'unresolved';
  readonly benefitItem: Slot<MockBenefitItem>;
  readonly cancellation: Exclude<CancellationEvidence, 'unknown'> | 'unresolved';
  readonly idempotency: readonly IdempotencyEvidence[] | null;
}
export const NO_SUPPLEMENT: Supplement = Object.freeze({ billingInterval: 'unresolved', benefitItem: 'unresolved', cancellation: 'unresolved', idempotency: null });

export interface AuditScope { readonly businessId: string; readonly invoiceId: string }
export interface ReadProvider {
  readonly kind: EvidenceOrigin;
  /** The API version every read is made with. */
  readonly apiVersion: string;
  /** Checks, WITHOUT any provider call, that every read this provider will make is permitted now. */
  preflight(scope: AuditScope & { customerId: string; subscriptionId: string }): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; reason: AcquireDenial }>>;
  getAccount(scope: AuditScope): Promise<ObjectRead>;
  getInvoice(scope: AuditScope): Promise<ObjectRead>;
  listInvoiceLines(scope: AuditScope): Promise<ListRead>;
  listInvoicePayments(scope: AuditScope): Promise<ListRead>;
  listRefunds(scope: AuditScope, target: PaymentTarget | null): Promise<ListRead>;
  listDisputes(scope: AuditScope, target: PaymentTarget | null): Promise<ListRead>;
  supplement(scope: AuditScope): Promise<Supplement>;
}

const INVOICE_ID = /^in_[A-Za-z0-9]+$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,159}$/;

export function createRealReadProvider(deps: Readonly<{ transport: StripeReadTransport; authorization: ReadAuthorization | null; clock: () => number; audit: AuditSink; apiVersion?: string }>): ReadProvider {
  const emit = makeEmitter(deps.audit, deps.clock, 'STRIPE_TEST_READ');
  const run = async (id: 'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE', scope: AuditScope, params?: { invoiceId: string }): Promise<ObjectRead> => {
    emit('stripe_read.attempt', id, null, scope);
    try { return { ok: true, body: await deps.transport.get(id, params) }; }
    catch (e) {
      const failureClass = e instanceof ProviderReadError ? e.failureClass : 'NETWORK';
      emit('stripe_read.failure', id, failureClass, scope);
      return { ok: false, kind: 'PROVIDER_FAILURE', failureClass };
    }
  };
  const denyList = (id: ReadMethodId, scope: AuditScope): ListRead => {
    // the registry marks these NOT_AUTHORIZED whatever the authorization says; the transport is never consulted
    emit('stripe_read.denied', id, 'METHOD_NOT_AUTHORIZED', scope);
    return { ok: false, kind: 'DENIED', reason: 'METHOD_NOT_AUTHORIZED' };
  };
  const provider: ReadProvider = {
    kind: 'STRIPE_TEST_READ',
    apiVersion: deps.apiVersion ?? STRIPE_API_VERSION,
    async preflight(scope) {
      if (!scope || !TOKEN.test(String(scope.businessId)) || !INVOICE_ID.test(String(scope.invoiceId)) || !TOKEN.test(String(scope.customerId)) || !TOKEN.test(String(scope.subscriptionId))) {
        emit('stripe_read.denied', 'UNKNOWN', 'INVALID_REQUEST', null);
        return { ok: false, reason: 'INVALID_REQUEST' } as const;
      }
      const now = deps.clock();
      for (const id of ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as const) {
        const d = decideCapability(id, deps.authorization, now);
        if (!d.allowed) { emit('stripe_read.denied', id, d.reason, scope); return { ok: false, reason: d.reason } as const; }
      }
      return { ok: true } as const;
    },
    getAccount: scope => run('ACCOUNT_RETRIEVE_CURRENT', scope),
    getInvoice: scope => run('INVOICE_RETRIEVE', scope, { invoiceId: scope.invoiceId }),
    async listInvoiceLines(scope) { return denyList('INVOICE_LINES_LIST', scope); },
    async listInvoicePayments(scope) { return denyList('PAYMENT_RETRIEVE', scope); },
    async listRefunds(scope) { return denyList('REFUNDS_LIST', scope); },
    async listDisputes(scope) { return denyList('DISPUTES_LIST', scope); },
    async supplement() { return NO_SUPPLEMENT; },
  };
  return Object.freeze(provider);
}

/** Fixture for one object read: the body to return, or a classed provider failure. A sequence is consumed in order and the last entry repeats. */
export type MockObjectFixture = unknown | { readonly throws: FailureClass };
export type MockListFixture = readonly PageRecord[] | { readonly throws: FailureClass } | 'DENIED';
export interface MockProviderFixtures {
  readonly apiVersion?: string;
  readonly account: MockObjectFixture;
  readonly invoices: readonly MockObjectFixture[];
  readonly lines?: MockListFixture;
  readonly payments?: MockListFixture;
  readonly refunds?: MockListFixture;
  readonly disputes?: MockListFixture;
  readonly supplement?: Partial<Supplement>;
}
export interface MockReadProvider extends ReadProvider { readonly kind: 'MOCK_FIXTURE'; readonly calls: string[] }

export function createMockReadProvider(f: MockProviderFixtures): MockReadProvider {
  const calls: string[] = []; let invoiceReads = 0;
  const throwsOf = (x: unknown): FailureClass | null => (x !== null && typeof x === 'object' && 'throws' in (x as object) ? ((x as { throws: FailureClass }).throws) : null);
  const object = (label: string, x: unknown): ObjectRead => { calls.push(label); const t = throwsOf(x); return t ? { ok: false, kind: 'PROVIDER_FAILURE', failureClass: t } : { ok: true, body: x }; };
  const list = (label: string, x: MockListFixture | undefined, target?: PaymentTarget | null): ListRead => {
    if (target === null) return { ok: false, kind: 'DENIED', reason: 'NO_TARGET' };
    calls.push(label + (target ? `:${target.kind}:${target.ref}` : ''));
    if (x === 'DENIED' || x === undefined) return { ok: false, kind: 'DENIED', reason: 'METHOD_NOT_AUTHORIZED' };
    const t = throwsOf(x);
    return t ? { ok: false, kind: 'PROVIDER_FAILURE', failureClass: t } : { ok: true, pages: x as readonly PageRecord[] };
  };
  const provider: MockReadProvider = {
    kind: 'MOCK_FIXTURE', apiVersion: f.apiVersion ?? STRIPE_API_VERSION, calls,
    async preflight(scope) { return scope && [scope.businessId, scope.invoiceId].every(x => typeof x === 'string' && x.length > 0) ? ({ ok: true } as const) : ({ ok: false, reason: 'INVALID_REQUEST' } as const); },
    async getAccount() { return object('account', f.account); },
    async getInvoice() { const x = f.invoices[Math.min(invoiceReads++, f.invoices.length - 1)]; return object('invoice', x); },
    async listInvoiceLines() { return list('lines', f.lines); },
    async listInvoicePayments() { return list('payments', f.payments); },
    async listRefunds(_s, target) { return list('refunds', f.refunds, target); },
    async listDisputes(_s, target) { return list('disputes', f.disputes, target); },
    async supplement() { return { ...NO_SUPPLEMENT, ...f.supplement }; },
  };
  return Object.freeze(provider);
}
export type { MockLineAttribution, MockPaymentDispute, MockRefund };
