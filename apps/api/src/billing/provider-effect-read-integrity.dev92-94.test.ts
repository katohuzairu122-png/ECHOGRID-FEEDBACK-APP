import { describe, expect, it, vi } from 'vitest';
import {
  retrieveProviderEffect,
  toSagaObservation,
  type ProviderInvoiceReader,
  type ExpectedProviderScope,
} from './provider-effect.adapter';

const expected: ExpectedProviderScope = {
  accountId: 'acct_A', livemode: false, invoiceRef: 'in_1',
  customerId: 'cus_1', subscriptionId: 'sub_1',
  reservationRef: 'res-1', currency: 'usd',
};

function mockReader(lines: unknown, hasMore: unknown = false) {
  const currentAccount = vi.fn(async () => ({ id: 'acct_A' }));
  const retrieveInvoice = vi.fn(async () => ({
    id: 'in_1', livemode: false, customerId: 'cus_1',
    subscriptionId: 'sub_1', currency: 'usd', status: 'paid', amountRemaining: 0,
  }));
  const listInvoiceLines = vi.fn(async () => ({ data: lines, hasMore }));
  return { currentAccount, retrieveInvoice, listInvoiceLines };
}

function assertUnverifiable(result: Awaited<ReturnType<typeof retrieveProviderEffect>>) {
  expect(result).toEqual({ kind: 'incomplete', reason: 'LINES_MALFORMED', linesInspected: 0 });
  expect(toSagaObservation(result, expected)).toEqual({ status: 'unreachable' });
}

const goodLine = { id: 'li_valid', amount: 100, currency: 'usd', metadata: null };

describe('Group 16 read-only provider-operation integrity', () => {
  it.each([
    null, undefined, {}, [],
    { ...expected, accountId: 'acct_' },
    { ...expected, accountId: 'acct_A/foreign' },
    { ...expected, customerId: 'cus_' },
    { ...expected, subscriptionId: 'sub_bad/foreign' },
    { ...expected, reservationRef: 'res/foreign' },
    { ...expected, invoiceRef: 'in_1?invalid' },
  ])('DEV-92 refuses invalid expected provider identity without provider calls %#', async (scope) => {
    const r = mockReader([goodLine]);
    const result = await retrieveProviderEffect(r as ProviderInvoiceReader, scope as ExpectedProviderScope);
    expect(result).toEqual({ kind: 'scope_mismatch', reason: 'SCOPE_INVALID' });
    expect(r.currentAccount).not.toHaveBeenCalled();
    expect(r.retrieveInvoice).not.toHaveBeenCalled();
    expect(r.listInvoiceLines).not.toHaveBeenCalled();
  });

  it.each([
    null, undefined, {}, 'not-an-array',
    [null], [{}], [{ ...goodLine, id: '' }],
    [{ ...goodLine, id: 'line/other' }],
    [{ ...goodLine, amount: Number.NaN }],
    [{ ...goodLine, amount: Number.POSITIVE_INFINITY }],
    [{ ...goodLine, amount: 1.5 }],
    [{ ...goodLine, currency: 'USD' }],
    [{ ...goodLine, metadata: [] }],
    [{ ...goodLine, metadata: { echogrid_reservation_ref: 42 } }],
    [goodLine, null],
  ])('DEV-93 refuses a malformed provider line page as incomplete %#', async (data) => {
    const r = mockReader(data);
    assertUnverifiable(await retrieveProviderEffect(r as ProviderInvoiceReader, expected));
  });

  it.each([undefined, null, 'false', 0, 1])(
    'DEV-94 rejects malformed pagination hasMore %#', async (hasMore) => {
      const r = mockReader([goodLine], hasMore);
      assertUnverifiable(await retrieveProviderEffect(r as ProviderInvoiceReader, expected));
    },
  );

  it('DEV-94 accepts valid empty final page as one complete absence observation only', async () => {
    const r = mockReader([]);
    const result = await retrieveProviderEffect(r as ProviderInvoiceReader, expected);
    expect(result).toEqual({ kind: 'absent_complete', linesInspected: 0 });
    expect(toSagaObservation(result, expected)).toBeNull();
  });

  it('does not transform a valid unattributed invoice line into a benefit', async () => {
    const r = mockReader([goodLine]);
    expect(await retrieveProviderEffect(r as ProviderInvoiceReader, expected))
      .toEqual({ kind: 'absent_complete', linesInspected: 1 });
  });
});
