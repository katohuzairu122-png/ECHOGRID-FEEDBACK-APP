import { describe, it, expect } from 'vitest';
import {
  RESERVATION_METADATA_KEY, classifyProviderError, defaultEffectExtractor, nextRetryDelayMs, retrieveProviderEffect, toSagaObservation,
  type ExpectedProviderScope, type ProviderInvoice, type ProviderInvoiceLine, type ProviderInvoiceReader,
} from './provider-effect.adapter';
import { stripeInvoiceReader } from './stripe-invoice-reader';

const EXPECTED: ExpectedProviderScope = { accountId: 'acct_A', livemode: true, invoiceRef: 'in_1', customerId: 'cus_1', subscriptionId: 'sub_1', currency: 'usd', reservationRef: 'res-1' };
const INVOICE: ProviderInvoice = { id: 'in_1', livemode: true, customerId: 'cus_1', subscriptionId: 'sub_1', currency: 'usd', status: 'paid', amountRemaining: 0 };
const line = (id: string, amount: number, over: Partial<ProviderInvoiceLine> = {}): ProviderInvoiceLine => ({ id, amount, currency: 'usd', metadata: null, ...over });
const benefit = (id: string, amount = -300, res = 'res-1') => line(id, amount, { metadata: { [RESERVATION_METADATA_KEY]: res } });

type Pages = ProviderInvoiceLine[][];
function reader(over: { account?: string; invoice?: Partial<ProviderInvoice> | Error; pages?: Pages; failPage?: number; accountError?: unknown } = {}) {
  const calls: string[] = [];
  const pages = over.pages ?? [[line('li_base', 10_000)]];
  const r: ProviderInvoiceReader = {
    async currentAccount() { calls.push('account'); if (over.accountError) throw over.accountError; return { id: over.account ?? 'acct_A' }; },
    async retrieveInvoice() { calls.push('invoice'); if (over.invoice instanceof Error) throw over.invoice; return { ...INVOICE, ...(over.invoice ?? {}) }; },
    async listInvoiceLines(_id, after) {
      calls.push(`lines:${after ?? '-'}`);
      const idx = after === undefined ? 0 : pages.findIndex(p => p[p.length - 1]?.id === after) + 1;
      if (over.failPage === idx) throw Object.assign(new Error('boom'), { type: 'StripeConnectionError' });
      return { data: pages[idx] ?? [], hasMore: idx < pages.length - 1 };
    },
  };
  return { r, calls };
}
const run = (o: Parameters<typeof reader>[0] = {}, e: Partial<ExpectedProviderScope> = {}) => { const x = reader(o); return retrieveProviderEffect(x.r, { ...EXPECTED, ...e }).then(res => ({ res, calls: x.calls })); };

describe('provider-effect adapter (read-only, mocked provider)', () => {
  it('reports an effect only for a line attributed to THIS reservation; other lines and other reservations are not effects', async () => {
    const { res } = await run({ pages: [[line('li_base', 10_000), benefit('ef_1'), benefit('ef_other', -500, 'res-2'), line('li_tax', 1_000), line('li_neg_plain', -200)]] });
    expect(res).toEqual({ kind: 'effect_present', linesInspected: 5, effects: [{ effectRef: 'ef_1', amountMinor: 300, currency: 'usd', attributedToReservationRef: 'res-1' }] });
  });

  it('absence requires a COMPLETE retrieval: no attributed effect after every page is read', async () => {
    const { res } = await run({ pages: [[line('li_base', 10_000)], [line('li_2', 5), benefit('ef_other', -100, 'res-9')]] });
    expect(res).toEqual({ kind: 'absent_complete', linesInspected: 3 });
  });

  it('reads every line page by cursor and finds an effect on a later page', async () => {
    const { res, calls } = await run({ pages: [[line('a', 1)], [line('b', 1)], [benefit('ef_late')]] });
    expect(res).toMatchObject({ kind: 'effect_present', effects: [{ effectRef: 'ef_late' }] });
    expect(calls).toEqual(['account', 'invoice', 'lines:-', 'lines:a', 'lines:b']);
  });

  it('a page cap or an unpageable hasMore is incomplete, never absence', async () => {
    const many: Pages = Array.from({ length: 30 }, (_, i) => [line(`p${i}`, 1)]);
    expect(await run({ pages: many }).then(x => x.res)).toMatchObject({ kind: 'incomplete', reason: 'LINES_PAGE_LIMIT' });
    const stuck: ProviderInvoiceReader = { ...reader().r, async listInvoiceLines() { return { data: [], hasMore: true }; } };
    expect(await retrieveProviderEffect(stuck, EXPECTED)).toMatchObject({ kind: 'incomplete' });
  });

  it.each([
    ['account', { account: 'acct_OTHER' }, 'ACCOUNT_MISMATCH'],
    ['livemode', { invoice: { livemode: false } }, 'LIVEMODE_MISMATCH'],
    ['invoice id', { invoice: { id: 'in_other' } }, 'INVOICE_ID_MISMATCH'],
    ['customer', { invoice: { customerId: 'cus_other' } }, 'CUSTOMER_MISMATCH'],
    ['subscription', { invoice: { subscriptionId: 'sub_other' } }, 'SUBSCRIPTION_MISMATCH'],
    ['currency', { invoice: { currency: 'eur' } }, 'CURRENCY_MISMATCH'],
  ] as const)('refuses to trust the invoice on %s mismatch and never reads its lines', async (_n, over, reason) => {
    const { res, calls } = await run(over as never);
    expect(res).toEqual({ kind: 'scope_mismatch', reason });
    expect(calls.some(c => c.startsWith('lines'))).toBe(false);
  });

  it('a missing invoice is an identity failure, not absence of the benefit', async () => {
    const { res } = await run({ invoice: Object.assign(new Error('No such invoice'), { type: 'StripeInvalidRequestError', code: 'resource_missing', statusCode: 404 }) });
    expect(res).toEqual({ kind: 'scope_mismatch', reason: 'INVOICE_NOT_FOUND' });
  });

  it('rejects an invalid expected scope before any provider call', async () => {
    for (const bad of [{ accountId: 'x' }, { invoiceRef: 'inv_1' }, { currency: 'USD' }, { reservationRef: '' }, { customerId: '' }]) {
      const x = reader();
      expect(await retrieveProviderEffect(x.r, { ...EXPECTED, ...bad })).toEqual({ kind: 'scope_mismatch', reason: 'SCOPE_INVALID' });
      expect(x.calls).toEqual([]);
    }
  });

  it('a failure while reading lines is an error outcome, never absence', async () => {
    const { res } = await run({ pages: [[line('a', 1)], [line('b', 1)]], failPage: 1 });
    expect(res).toMatchObject({ kind: 'error', errorClass: 'retryable' });
    expect((await run({ accountError: { type: 'StripeAuthenticationError', statusCode: 401 } })).res).toMatchObject({ kind: 'error', errorClass: 'permanent', status: 401 });
  });

  describe('error classification and redaction', () => {
    it.each([
      ['rate limit by type', { type: 'StripeRateLimitError', code: 'rate_limit', headers: { 'retry-after': '7' } }, 'rate_limited', 7000],
      ['rate limit by status', { statusCode: 429 }, 'rate_limited', undefined],
      ['connection', { type: 'StripeConnectionError' }, 'retryable', undefined],
      ['api 5xx', { type: 'StripeAPIError', statusCode: 503 }, 'retryable', undefined],
      ['timeout code', { code: 'ETIMEDOUT' }, 'retryable', undefined],
      ['idempotency/conflict', { statusCode: 409 }, 'retryable', undefined],
      ['authentication', { type: 'StripeAuthenticationError', statusCode: 401 }, 'permanent', undefined],
      ['permission', { type: 'StripePermissionError', statusCode: 403 }, 'permanent', undefined],
      ['unknown shape', 'weird', 'permanent', undefined],
      ['null', null, 'permanent', undefined],
    ] as const)('%s', (_n, e, errorClass, retryAfterMs) => {
      const c = classifyProviderError(e);
      expect(c).toMatchObject({ kind: 'error', errorClass });
      expect(c.retryAfterMs).toBe(retryAfterMs);
    });

    it('never returns a message, header, payload or credential: only a code, class and status', () => {
      const secret = 'sk_live_SUPERSECRET';
      const c = classifyProviderError(Object.assign(new Error(`Invalid API Key provided: ${secret}`), {
        type: 'StripeAuthenticationError', statusCode: 401, code: 'api_key_invalid', headers: { authorization: `Bearer ${secret}`, 'request-id': 'req_1' }, raw: { message: secret, headers: { authorization: secret } }, requestBody: secret,
      }));
      expect(JSON.stringify(c)).not.toContain(secret);
      expect(Object.keys(c).sort()).toEqual(['code', 'errorClass', 'kind', 'status']);
      expect(classifyProviderError({ code: 'bad code with spaces & secrets sk_live_x' }).code).toBe('provider_error'); // unsafe codes are replaced
    });
  });

  describe('what the saga is told', () => {
    const scope = { invoiceRef: 'in_1', reservationRef: 'res-1', currency: 'usd' };
    it('one attributed effect is forwarded as that effect', () => {
      expect(toSagaObservation({ kind: 'effect_present', linesInspected: 1, effects: [{ effectRef: 'ef_1', amountMinor: 300, currency: 'usd', attributedToReservationRef: 'res-1' }] }, scope))
        .toEqual({ status: 'effect_present', effectRef: 'ef_1', amountMinor: 300, currency: 'usd', invoiceRef: 'in_1', attributedToReservationRef: 'res-1' });
    });
    it('two effects for one reservation are a duplicate application: forwarded as unattributed so the saga holds them', () => {
      const o = toSagaObservation({ kind: 'effect_present', linesInspected: 2, effects: [{ effectRef: 'b', amountMinor: 300, currency: 'usd', attributedToReservationRef: 'res-1' }, { effectRef: 'a', amountMinor: 300, currency: 'usd', attributedToReservationRef: 'res-1' }] }, scope);
      expect(o).toMatchObject({ status: 'effect_present', effectRef: 'a+b', amountMinor: 600, attributedToReservationRef: null });
    });
    it('absence is NEVER forwarded from one retrieval; everything unverifiable is forwarded as unreachable (hold, never release)', () => {
      expect(toSagaObservation({ kind: 'absent_complete', linesInspected: 3 }, scope)).toBeNull();
      for (const r of [{ kind: 'incomplete', reason: 'LINES_PAGE_LIMIT', linesInspected: 1 }, { kind: 'scope_mismatch', reason: 'ACCOUNT_MISMATCH' }, { kind: 'error', errorClass: 'retryable', code: 'x' }, { kind: 'error', errorClass: 'permanent', code: 'x' }] as const)
        expect(toSagaObservation(r, scope)).toEqual({ status: 'unreachable' });
    });
  });

  it('default extractor ignores positive lines, lines without our reservation key and non-negative amounts', () => {
    expect(defaultEffectExtractor([line('a', 100, { metadata: { [RESERVATION_METADATA_KEY]: 'res-1' } }), line('b', -100), line('c', 0), benefit('d')])).toEqual([{ effectRef: 'd', amountMinor: 300, currency: 'usd', attributedToReservationRef: 'res-1' }]);
  });

  describe('retry delay', () => {
    it('is exponential, bounded, jittered within +/-25%, and honours Retry-After as a floor', () => {
      expect(nextRetryDelayMs(1, undefined, () => 0.5)).toBe(30_000);
      expect(nextRetryDelayMs(2, undefined, () => 0.5)).toBe(60_000);
      expect(nextRetryDelayMs(3, undefined, () => 0)).toBe(90_000);
      expect(nextRetryDelayMs(3, undefined, () => 1)).toBe(150_000);
      expect(nextRetryDelayMs(40, undefined, () => 0.5)).toBe(3_600_000);
      expect(nextRetryDelayMs(1, 120_000, () => 0.5)).toBe(120_000);
      expect(nextRetryDelayMs(1, undefined, () => Number.NaN)).toBe(30_000); // a broken jitter source falls back to the midpoint
    });
  });

  describe('Stripe binding (fake client: no network)', () => {
    it('uses only three read calls and maps the provider objects', async () => {
      const calls: string[] = [];
      const fake = {
        accounts: { retrieveCurrent: async () => { calls.push('accounts.retrieveCurrent'); return { id: 'acct_A' }; } },
        invoices: {
          retrieve: async (id: string) => { calls.push('invoices.retrieve'); return { id, livemode: true, customer: { id: 'cus_1' }, parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } }, currency: 'usd', status: 'paid', amount_remaining: 0 }; },
          listLineItems: async (_id: string, p: { limit: number; starting_after?: string }) => { calls.push(`invoices.listLineItems:${p.starting_after ?? '-'}`); return { data: [{ id: 'il_1', amount: -300, currency: 'usd', metadata: { [RESERVATION_METADATA_KEY]: 'res-1' } }], has_more: false }; },
        },
      };
      const res = await retrieveProviderEffect(stripeInvoiceReader(fake as never), EXPECTED);
      expect(res).toMatchObject({ kind: 'effect_present', effects: [{ effectRef: 'il_1', amountMinor: 300 }] });
      expect(calls).toEqual(['accounts.retrieveCurrent', 'invoices.retrieve', 'invoices.listLineItems:-']);
      const reader = stripeInvoiceReader(fake as never);
      expect(Object.keys(reader).sort()).toEqual(['currentAccount', 'listInvoiceLines', 'retrieveInvoice']);
    });
  });
});
