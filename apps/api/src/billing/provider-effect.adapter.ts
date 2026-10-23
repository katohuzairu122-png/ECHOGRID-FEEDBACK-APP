/**
 * Split 08 provider-effect retrieval: a READ-ONLY, injectable adapter that asks the provider what, if anything, has been applied to an invoice for ONE
 * reservation, and reports an explicit outcome. It never writes to the provider, never mutates the database and never authorizes anything.
 *
 * Rules it enforces (owner decisions 2026-10-23 and the Split 08 freeze gate):
 *  - a successful API response is NOT a successfully applied benefit: an effect counts only when a line is attributed to this reservation, on this
 *    invoice, in the expected currency (amount/attribution are then judged by the saga's classifier);
 *  - absence is reported only after a COMPLETE retrieval (identity verified, every line page read); a missing invoice, an error, a truncated list or a
 *    page-limit hit is never absence; and even `absent_complete` is only ONE observation, the reconciler needs repeated ones (single-query absence is
 *    never enough);
 *  - account and operating mode are verified before anything on the invoice is trusted;
 *  - errors are classified (retryable, rate limited with Retry-After, permanent) and REDACTED to a code/type/status: no message, header, payload or credential
 *    is ever returned or logged.
 * The Stripe object that represents "the benefit" has not been chosen by the owner. The default extractor is therefore a clearly labelled CANDIDATE scheme
 * (negative invoice lines carrying our reservation reference); a different instrument means a different extractor, not a different adapter.
 */
export interface ProviderInvoice {
  id: string;
  livemode: boolean;
  customerId: string | null;
  subscriptionId: string | null;
  currency: string;
  status: string | null;
  amountRemaining: number | null;
}

export interface ProviderInvoiceLine {
  id: string;
  /** Signed minor units; a benefit/discount line is negative. */
  amount: number;
  currency: string;
  metadata: Readonly<Record<string, string>> | null;
}

export interface ProviderInvoiceReader {
  currentAccount(): Promise<{ id: string }>;
  retrieveInvoice(id: string): Promise<ProviderInvoice>;
  listInvoiceLines(id: string, startingAfter?: string): Promise<{ data: readonly ProviderInvoiceLine[]; hasMore: boolean }>;
}

export interface ExpectedProviderScope {
  accountId: string;
  livemode: boolean;
  invoiceRef: string;
  customerId: string;
  subscriptionId: string;
  currency: string;
  reservationRef: string;
}

export interface ProviderEffectCandidate {
  effectRef: string;
  /** Positive minor units of benefit. */
  amountMinor: number;
  currency: string;
  attributedToReservationRef: string | null;
}

export type ScopeMismatchReason = 'ACCOUNT_MISMATCH' | 'LIVEMODE_MISMATCH' | 'INVOICE_ID_MISMATCH' | 'CUSTOMER_MISMATCH' | 'SUBSCRIPTION_MISMATCH' | 'CURRENCY_MISMATCH' | 'INVOICE_NOT_FOUND' | 'SCOPE_INVALID';
export type RetrievalErrorClass = 'retryable' | 'rate_limited' | 'permanent';

export type ProviderEffectRetrieval =
  | { kind: 'effect_present'; effects: ProviderEffectCandidate[]; linesInspected: number }
  | { kind: 'absent_complete'; linesInspected: number }
  | { kind: 'incomplete'; reason: 'LINES_PAGE_LIMIT'; linesInspected: number }
  | { kind: 'scope_mismatch'; reason: ScopeMismatchReason }
  | { kind: 'error'; errorClass: RetrievalErrorClass; code: string; status?: number; retryAfterMs?: number };

/** Candidate scheme: a negative invoice line whose metadata carries `echogrid_reservation_ref`. Lines without it are other invoice content, not effects. */
export const RESERVATION_METADATA_KEY = 'echogrid_reservation_ref';
export const defaultEffectExtractor = (lines: readonly ProviderInvoiceLine[]): ProviderEffectCandidate[] =>
  lines.filter(l => l.amount < 0 && l.metadata !== null && RESERVATION_METADATA_KEY in l.metadata)
    .map(l => ({ effectRef: l.id, amountMinor: -l.amount, currency: l.currency, attributedToReservationRef: l.metadata![RESERVATION_METADATA_KEY] ?? null }));

export type EffectExtractor = (lines: readonly ProviderInvoiceLine[]) => ProviderEffectCandidate[];

const MAX_LINE_PAGES = 20;
const ID = /^[A-Za-z0-9_]+$/;

/** Redacts an unknown thrown value to code/type/status only. Never returns or logs a message, header, request body or credential. */
export function classifyProviderError(e: unknown): Extract<ProviderEffectRetrieval, { kind: 'error' }> {
  const x = (e ?? {}) as { type?: unknown; code?: unknown; statusCode?: unknown; status?: unknown; headers?: unknown; raw?: { statusCode?: unknown; headers?: unknown } };
  const type = typeof x.type === 'string' ? x.type : 'unknown';
  const rawCode = typeof x.code === 'string' && ID.test(x.code) ? x.code : null;
  const status = [x.statusCode, x.status, x.raw?.statusCode].find((s): s is number => typeof s === 'number' && Number.isInteger(s));
  const headers = (x.headers ?? x.raw?.headers ?? {}) as Record<string, unknown>;
  const ra = Number(headers['retry-after']);
  const retryAfterMs = Number.isFinite(ra) && ra >= 0 ? Math.min(Math.round(ra * 1000), 3_600_000) : undefined;
  const code = rawCode ?? (type !== 'unknown' && ID.test(type) ? type : 'provider_error');
  const withStatus = (c: Extract<ProviderEffectRetrieval, { kind: 'error' }>) => ({ ...c, ...(status !== undefined ? { status } : {}) });
  if (type === 'StripeRateLimitError' || status === 429) return withStatus({ kind: 'error', errorClass: 'rate_limited', code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
  if (type === 'StripeAuthenticationError' || type === 'StripePermissionError' || status === 401 || status === 403) return withStatus({ kind: 'error', errorClass: 'permanent', code });
  if (type === 'StripeConnectionError' || type === 'StripeAPIError' || (status !== undefined && status >= 500) || /timeout|timedout|etimedout|econn/i.test(String(x.code ?? '') + type)) return withStatus({ kind: 'error', errorClass: 'retryable', code });
  if (status === 409 || type === 'StripeIdempotencyError') return withStatus({ kind: 'error', errorClass: 'retryable', code });
  return withStatus({ kind: 'error', errorClass: 'permanent', code });
}

export async function retrieveProviderEffect(reader: ProviderInvoiceReader, expected: ExpectedProviderScope, extract: EffectExtractor = defaultEffectExtractor): Promise<ProviderEffectRetrieval> {
  if (![expected.accountId, expected.invoiceRef, expected.customerId, expected.subscriptionId, expected.reservationRef].every(s => typeof s === 'string' && s !== '') ||
      !expected.accountId.startsWith('acct_') || !expected.invoiceRef.startsWith('in_') || !/^[a-z]{3}$/.test(expected.currency) || typeof expected.livemode !== 'boolean')
    return { kind: 'scope_mismatch', reason: 'SCOPE_INVALID' };
  try {
    // 1. account and operating mode before anything else is trusted
    const account = await reader.currentAccount();
    if (account.id !== expected.accountId) return { kind: 'scope_mismatch', reason: 'ACCOUNT_MISMATCH' };
    let invoice: ProviderInvoice;
    try {
      invoice = await reader.retrieveInvoice(expected.invoiceRef);
    } catch (e) {
      const c = classifyProviderError(e);
      // A missing invoice is an identity failure, never "the benefit is absent".
      if (c.status === 404 || c.code === 'resource_missing') return { kind: 'scope_mismatch', reason: 'INVOICE_NOT_FOUND' };
      return c;
    }
    if (invoice.livemode !== expected.livemode) return { kind: 'scope_mismatch', reason: 'LIVEMODE_MISMATCH' };
    if (invoice.id !== expected.invoiceRef) return { kind: 'scope_mismatch', reason: 'INVOICE_ID_MISMATCH' };
    if (invoice.customerId !== expected.customerId) return { kind: 'scope_mismatch', reason: 'CUSTOMER_MISMATCH' };
    if (invoice.subscriptionId !== expected.subscriptionId) return { kind: 'scope_mismatch', reason: 'SUBSCRIPTION_MISMATCH' };
    if (invoice.currency !== expected.currency) return { kind: 'scope_mismatch', reason: 'CURRENCY_MISMATCH' };

    // 2. read EVERY line page; a page cap is incomplete, never absence
    const lines: ProviderInvoiceLine[] = [];
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_LINE_PAGES) return { kind: 'incomplete', reason: 'LINES_PAGE_LIMIT', linesInspected: lines.length };
      const r = await reader.listInvoiceLines(expected.invoiceRef, cursor);
      lines.push(...r.data);
      if (!r.hasMore) break;
      const last = r.data[r.data.length - 1];
      if (!last) return { kind: 'incomplete', reason: 'LINES_PAGE_LIMIT', linesInspected: lines.length }; // hasMore without data cannot be paged: not complete
      cursor = last.id;
    }

    // 3. only lines in the expected currency attributed to THIS reservation are effects of this reservation
    const effects = extract(lines).filter(c => c.attributedToReservationRef === expected.reservationRef);
    if (effects.length === 0) return { kind: 'absent_complete', linesInspected: lines.length };
    return { kind: 'effect_present', effects, linesInspected: lines.length };
  } catch (e) {
    return classifyProviderError(e);
  }
}

export type SagaObservation =
  | { status: 'effect_present'; effectRef: string; amountMinor: number; currency: string; invoiceRef: string; attributedToReservationRef: string | null }
  | { status: 'effect_absent'; checkedAt: number }
  | { status: 'unreachable' };

/**
 * Maps one retrieval to what the saga should hear, or null when the saga must hear NOTHING yet. Absence is never forwarded here: a single complete
 * query is not proof (the reconciler forwards it only after repeated, separated complete queries). Two effects for one reservation are a duplicate
 * application and are forwarded as unattributed so the saga holds them for a human.
 */
export function toSagaObservation(r: ProviderEffectRetrieval, expected: Pick<ExpectedProviderScope, 'invoiceRef' | 'reservationRef' | 'currency'>): SagaObservation | null {
  if (r.kind === 'effect_present') {
    const [only] = r.effects;
    if (r.effects.length === 1 && only) return { status: 'effect_present', effectRef: only.effectRef, amountMinor: only.amountMinor, currency: only.currency, invoiceRef: expected.invoiceRef, attributedToReservationRef: only.attributedToReservationRef };
    return { status: 'effect_present', effectRef: r.effects.map(e => e.effectRef).sort().join('+'), amountMinor: r.effects.reduce((n, e) => n + e.amountMinor, 0), currency: expected.currency, invoiceRef: expected.invoiceRef, attributedToReservationRef: null };
  }
  if (r.kind === 'absent_complete') return null;
  return { status: 'unreachable' }; // incomplete, scope mismatch and every error: cannot verify, so hold (never release)
}

/** Deterministic exponential backoff with an injected jitter source; honours a provider Retry-After as a floor. */
export function nextRetryDelayMs(attemptNo: number, retryAfterMs: number | undefined, rand: () => number = Math.random): number {
  const base = Math.min(30_000 * 2 ** Math.max(attemptNo - 1, 0), 3_600_000);
  const r = rand();
  const jittered = Math.round(base * (0.75 + 0.5 * (Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0.5)));
  return Math.max(jittered, retryAfterMs ?? 0);
}
