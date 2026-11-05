import type { FailureClass, ReadMethodId } from './capability-registry';
import type { EvidenceOrigin, MockLineAttribution } from './evidence-types';
import type { IdempotencyEvidence } from './line-normalizer';
import type { PageRecord } from './pagination';
import type { PaymentTarget } from './refund-dispute-normalizer';
import { makeEmitter, type AcquireDenial, type AuditSink } from './read-types';
import { STRIPE_API_VERSION } from './transport';
import type { ObservationClaims, ObservationKind, ObservationVerifier, TrustedReadRuntime } from './trusted-runtime';
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

export interface AuditScope { readonly businessId: string; readonly invoiceId: string; /** The expected (approved) Stripe test account, from the trusted binding. Real providers need it to find the authorization. */ readonly accountId?: string }
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

export interface RealReadProvider extends ReadProvider {
  /** REAL_NETWORK only when every observation came from the trusted runtime and verified as such; SYNTHETIC_RUNTIME when the runtime is the synthetic one. */
  readonly authenticity: ObservationKind;
  /** The verified claims of every observation this provider has served, oldest first. Claims only: never a body, a header or a credential. */
  provenance(): readonly ObservationClaims[];
}

/**
 * DEV-10: the real provider no longer accepts a transport. Every read goes through a TRUSTED RUNTIME (authorization and mapping gate rechecked immediately before the request, bound credential,
 * signed observation) and every observation is verified against the trusted key ring and the expected binding before its body is used. An observation that does not verify is a denial and its body
 * is discarded.
 */
export function createRealReadProvider(deps: Readonly<{ runtime: TrustedReadRuntime; verifier: ObservationVerifier; clock: () => number; audit: AuditSink; apiVersion?: string }>): RealReadProvider {
  const emit = makeEmitter(deps.audit, deps.clock, 'STRIPE_TEST_READ');
  const apiVersion = deps.apiVersion ?? STRIPE_API_VERSION;
  const log: ObservationClaims[] = [];
  const check = async (id: 'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE', scope: AuditScope): Promise<AcquireDenial | null> => {
    if (typeof scope.accountId !== 'string') { emit('stripe_read.denied', id, 'INVALID_REQUEST', scope); return 'INVALID_REQUEST'; }
    const d = await deps.runtime.check({ businessId: scope.businessId, accountId: scope.accountId, methodId: id, apiVersion, purpose: 'EVIDENCE' });
    if (d.ok) return null;
    emit('stripe_read.denied', id, d.reason, scope);
    return d.reason;
  };
  const run = async (id: 'ACCOUNT_RETRIEVE_CURRENT' | 'INVOICE_RETRIEVE', scope: AuditScope, invoiceId?: string): Promise<ObjectRead> => {
    if (typeof scope.accountId !== 'string') { emit('stripe_read.denied', id, 'INVALID_REQUEST', scope); return { ok: false, kind: 'DENIED', reason: 'INVALID_REQUEST' }; }
    emit('stripe_read.attempt', id, null, scope); // the runtime rechecks authorization immediately before the request: a revocation takes effect on the very next one
    const out = await deps.runtime.read({ businessId: scope.businessId, accountId: scope.accountId, methodId: id, ...(invoiceId ? { invoiceId } : {}), apiVersion, purpose: 'EVIDENCE' });
    if (!out.ok) {
      if (out.kind === 'DENIED') { emit('stripe_read.denied', id, out.reason, scope); return { ok: false, kind: 'DENIED', reason: out.reason }; }
      emit('stripe_read.failure', id, out.failureClass, scope);
      return { ok: false, kind: 'PROVIDER_FAILURE', failureClass: out.failureClass };
    }
    const v = await deps.verifier.verify(out.observation, { kind: deps.runtime.kind, businessId: scope.businessId, accountId: scope.accountId, workloadId: deps.runtime.workloadId, methodId: id, subject: id === 'INVOICE_RETRIEVE' ? (invoiceId as string) : scope.accountId, apiVersion });
    if (!v.ok) { emit('stripe_read.denied', id, v.reason, scope); return { ok: false, kind: 'DENIED', reason: v.reason }; }
    log.push(v.claims);
    return { ok: true, body: v.body };
  };
  const denyList = (id: ReadMethodId, scope: AuditScope): ListRead => {
    // the registry marks these NOT_AUTHORIZED and the transport has no path for them: no record, mapping or setting changes that
    emit('stripe_read.denied', id, 'METHOD_NOT_AUTHORIZED', scope);
    return { ok: false, kind: 'DENIED', reason: 'METHOD_NOT_AUTHORIZED' };
  };
  const provider: RealReadProvider = {
    kind: 'STRIPE_TEST_READ',
    apiVersion,
    authenticity: deps.runtime.kind,
    provenance: () => Object.freeze([...log]),
    async preflight(scope) {
      if (!scope || !TOKEN.test(String(scope.businessId)) || !INVOICE_ID.test(String(scope.invoiceId)) || !TOKEN.test(String(scope.customerId)) || !TOKEN.test(String(scope.subscriptionId)) || typeof scope.accountId !== 'string') {
        emit('stripe_read.denied', 'UNKNOWN', 'INVALID_REQUEST', null);
        return { ok: false, reason: 'INVALID_REQUEST' } as const;
      }
      for (const id of ['ACCOUNT_RETRIEVE_CURRENT', 'INVOICE_RETRIEVE'] as const) { const d = await check(id, scope); if (d) return { ok: false, reason: d } as const; }
      return { ok: true } as const;
    },
    getAccount: scope => run('ACCOUNT_RETRIEVE_CURRENT', scope),
    getInvoice: scope => run('INVOICE_RETRIEVE', scope, scope.invoiceId),
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
