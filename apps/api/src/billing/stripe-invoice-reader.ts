import type Stripe from 'stripe';
import type { ProviderInvoice, ProviderInvoiceLine, ProviderInvoiceReader } from './provider-effect.adapter';

/**
 * Thin READ-ONLY binding of the provider-effect adapter to the Stripe SDK. Three GET calls only (current account, one invoice, its line items); it holds
 * no write capability and the caller supplies the request-scoped, server-side client. It is never invoked by any route, queue or cron in this change
 * and no live Stripe call is made by tests (they pass a fake client).
 */
export function stripeInvoiceReader(stripe: Pick<Stripe, 'accounts' | 'invoices'>): ProviderInvoiceReader {
  const id = (v: string | { id: string } | null | undefined): string | null => (typeof v === 'string' ? v : v?.id ?? null);
  return {
    async currentAccount() {
      const a = await stripe.accounts.retrieveCurrent();
      return { id: a.id };
    },
    async retrieveInvoice(invoiceId: string): Promise<ProviderInvoice> {
      const inv = await stripe.invoices.retrieve(invoiceId);
      const sub = inv.parent?.type === 'subscription_details' ? inv.parent.subscription_details?.subscription : null;
      return {
        id: inv.id ?? '', livemode: inv.livemode, customerId: id(inv.customer), subscriptionId: id(sub), currency: inv.currency, status: inv.status ?? null,
        amountRemaining: typeof inv.amount_remaining === 'number' ? inv.amount_remaining : null,
      };
    },
    async listInvoiceLines(invoiceId: string, startingAfter?: string) {
      const page = await stripe.invoices.listLineItems(invoiceId, { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
      return {
        data: page.data.map((l): ProviderInvoiceLine => ({ id: l.id, amount: l.amount, currency: l.currency, metadata: l.metadata ?? null })),
        hasMore: page.has_more,
      };
    },
  };
}
