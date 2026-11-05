import { acquireEvidence } from './evidence-engine';
import type { NormalizedStripeEvidence } from './evidence-types';
import type { NormalizeDenial, TrustedInvoiceScope } from './invoice-normalizer';
import type { FrozenReference, IdempotencyEvidence } from './line-normalizer';
import type { PageRecord } from './pagination';
import type { ListRead, ReadProvider, Slot } from './read-provider';
import type { PaymentTarget } from './refund-dispute-normalizer';
import type { CancellationEvidence, MockBenefitItem } from '../settlement-eligibility.classifier';

/**
 * S08-D1D3-DEV-07: the TEST-ADAPTER side of the four unauthorized reads (`INVOICE_LINES_LIST`, `PAYMENT_RETRIEVE`, `REFUNDS_LIST`, `DISPUTES_LIST`).
 *
 * An `ExtendedReadSource` is typed and checked at runtime as `MOCK_FIXTURE`. There is deliberately no implementation that talks to Stripe and no way to build one from the real transport:
 * the real transport has exactly two paths (see transport.ts) and the capability registry keeps these four NOT_AUTHORIZED. Evidence acquired here is sealed `MOCK_FIXTURE`, so the classifier
 * bridge will classify it (positive mock paths) and will never treat it as authentic Stripe evidence. The raw pages are in the provider-profile shape, so the normalizers exercised here are the
 * ones a future authorized, proven real read would use.
 */
export interface ExtendedReadSource {
  readonly sourceKind: 'MOCK_FIXTURE';
  listInvoiceLines(invoiceId: string): Promise<readonly PageRecord[]>;
  listInvoicePayments(invoiceId: string): Promise<readonly PageRecord[]>;
  listRefunds(target: PaymentTarget): Promise<readonly PageRecord[]>;
  listDisputes(target: PaymentTarget): Promise<readonly PageRecord[]>;
}

/** Fixture-backed source. Every call is recorded so tests can assert what was (not) asked. */
export class MockExtendedSource implements ExtendedReadSource {
  readonly sourceKind = 'MOCK_FIXTURE' as const;
  readonly calls: string[] = [];
  constructor(private readonly fixtures: Readonly<{ lines?: readonly PageRecord[]; payments?: readonly PageRecord[]; refunds?: readonly PageRecord[]; disputes?: readonly PageRecord[] }>) {}
  async listInvoiceLines(invoiceId: string) { this.calls.push(`lines:${invoiceId}`); return this.fixtures.lines ?? []; }
  async listInvoicePayments(invoiceId: string) { this.calls.push(`payments:${invoiceId}`); return this.fixtures.payments ?? []; }
  async listRefunds(t: PaymentTarget) { this.calls.push(`refunds:${t.kind}:${t.ref}`); return this.fixtures.refunds ?? []; }
  async listDisputes(t: PaymentTarget) { this.calls.push(`disputes:${t.kind}:${t.ref}`); return this.fixtures.disputes ?? []; }
}

/** One complete page (no cursor, has_more=false). */
export const onePage = (data: readonly unknown[]): PageRecord[] => [{ requestedStartingAfter: null, body: { object: 'list', data, has_more: false, url: '/v1/fixture' } }];
/** The same items split into pages of `size`, with the cursors a correct client would have used. */
export function pagesOf(data: ReadonlyArray<{ id: string }>, size: number): PageRecord[] {
  const out: PageRecord[] = [];
  for (let i = 0; i < data.length || i === 0; i += size) {
    const slice = data.slice(i, i + size);
    out.push({ requestedStartingAfter: i === 0 ? null : data[i - 1]!.id, body: { object: 'list', data: slice, has_more: i + size < data.length, url: '/v1/fixture' } });
    if (data.length === 0) break;
  }
  return out;
}

export type { Slot } from './read-provider';
export interface ExtendedMockInput {
  readonly scope: TrustedInvoiceScope;
  readonly accountId: string;
  readonly observedAtMs: number;
  readonly apiVersion: string;
  readonly invoiceBefore: unknown;
  readonly invoiceAfter?: unknown;
  readonly source: ExtendedReadSource;
  /** Read-only references to the frozen allocation; never modified or recalculated. */
  readonly frozen: readonly FrozenReference[] | null;
  /** Separate provider evidence of the parent item's idempotency key (does not exist for real reads). */
  readonly idempotency: readonly IdempotencyEvidence[] | null;
  readonly billingInterval: 'month' | 'year' | 'unresolved';
  readonly benefitItem: Slot<MockBenefitItem>;
  readonly cancellation: Exclude<CancellationEvidence, 'unknown'> | 'unresolved';
}
export type ExtendedMockResult = { ok: true; evidence: NormalizedStripeEvidence } | { ok: false; denied: NormalizeDenial | 'METHOD_NOT_AUTHORIZED' };

/**
 * DEV-07 entry point, kept for its callers: since DEV-08 it is a thin wrapper that adapts the fixture source to the shared evidence engine (there is one acquisition implementation).
 * Behaviour is unchanged: a non-mock source is refused before any read; an API version without a profile yields a bundle in which everything is UNRESOLVED.
 */
export async function acquireMockExtendedEvidence(input: ExtendedMockInput): Promise<ExtendedMockResult> {
  if (!input?.source || input.source.sourceKind !== 'MOCK_FIXTURE') return { ok: false, denied: 'METHOD_NOT_AUTHORIZED' };
  const src = input.source;
  const asPages = async (read: () => Promise<readonly PageRecord[]>): Promise<ListRead> => ({ ok: true, pages: await read() });
  const provider: ReadProvider = {
    kind: 'MOCK_FIXTURE', apiVersion: input.apiVersion,
    async preflight() { return { ok: true } as const; },
    async getAccount() { return { ok: true, body: { object: 'account', id: input.accountId } } as const; },
    async getInvoice() { return { ok: true, body: input.invoiceAfter !== undefined && calls++ > 0 ? input.invoiceAfter : input.invoiceBefore } as const; },
    listInvoiceLines: s => asPages(() => src.listInvoiceLines(s.invoiceId)),
    listInvoicePayments: s => asPages(() => src.listInvoicePayments(s.invoiceId)),
    async listRefunds(_s, target) { return target === null ? ({ ok: false, kind: 'DENIED', reason: 'NO_TARGET' } as const) : asPages(() => src.listRefunds(target)); },
    async listDisputes(_s, target) { return target === null ? ({ ok: false, kind: 'DENIED', reason: 'NO_TARGET' } as const) : asPages(() => src.listDisputes(target)); },
    async supplement() { return { billingInterval: input.billingInterval, benefitItem: input.benefitItem, cancellation: input.cancellation, idempotency: input.idempotency }; },
  };
  let calls = 0;
  const out = await acquireEvidence({ provider, clock: () => input.observedAtMs, audit: () => undefined, onUnsupportedVersion: 'UNRESOLVED' }, input.scope, input.accountId, input.frozen);
  if (out.ok) return { ok: true, evidence: out.evidence };
  return { ok: false, denied: out.kind === 'DENIED' ? (out.reason as NormalizeDenial) : 'METHOD_NOT_AUTHORIZED' };
}
