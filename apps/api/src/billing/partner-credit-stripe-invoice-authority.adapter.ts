import type Stripe from 'stripe';

/**
 * Split 08: read-only provider authority probe.
 *
 * A Stripe invoice marked paid does not establish that a Partner Credit was
 * applied to it. This adapter NEVER authorizes terminal consumption.
 */
export type InvoiceAuthorityInspection =
  | { kind: 'invoice_mismatch'; reason: string }
  | { kind: 'invoice_verified_credit_unproven'; invoiceRef: string };

export interface ExpectedInvoiceIdentity {
  invoiceRef: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
}

/**
 * Uses the request-scoped server Stripe client. All expected identifiers
 * must come from trusted, tenant-checked subscription/reservation records,
 * NEVER an untrusted client payload.
 */
export class PartnerCreditStripeInvoiceAuthorityAdapter {
  constructor(private readonly stripe: Pick<Stripe, 'invoices'>) {}

  async inspect(expected: ExpectedInvoiceIdentity): Promise<InvoiceAuthorityInspection> {
    if (!expected.invoiceRef.startsWith('in_') ||
        !expected.stripeCustomerId.startsWith('cus_') ||
        !expected.stripeSubscriptionId.startsWith('sub_')) {
      return { kind: 'invoice_mismatch', reason: 'IDENTITY_INVALID' };
    }

    // Never interpret a webhook body alone as provider authority.
    const invoice = await this.stripe.invoices.retrieve(expected.invoiceRef);
    if (invoice.id !== expected.invoiceRef ||
        invoice.status !== 'paid' ||
        invoice.paid !== true ||
        invoice.amount_remaining !== 0 ||
        invoice.livemode !== true) {
      return { kind: 'invoice_mismatch', reason: 'INVOICE_NOT_PAID_OR_NOT_LIVE' };
    }
    const customerId = typeof invoice.customer === 'string'
      ? invoice.customer : invoice.customer?.id;
    const subscription = invoice.parent?.type === 'subscription_details'
      ? invoice.parent.subscription_details?.subscription : null;
    const subscriptionId = typeof subscription === 'string'
      ? subscription : subscription?.id;
    if (customerId !== expected.stripeCustomerId ||
        subscriptionId !== expected.stripeSubscriptionId) {
      return { kind: 'invoice_mismatch', reason: 'INVOICE_CUSTOMER_SUBSCRIPTION_MISMATCH' };
    }

    // Stripe has not yet provided a frozen, verifiable Partner Credit
    // application mechanism. Paid invoices alone cannot consume credits.
    return { kind: 'invoice_verified_credit_unproven', invoiceRef: invoice.id };
  }
}
