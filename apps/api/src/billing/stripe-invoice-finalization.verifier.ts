import type Stripe from 'stripe';

/** Read-only Split 08 invoice finalization preflight, not CE-1 consumption.
 * A paid invoice NEVER proves a Partner Credit benefit was applied.
 * Call only from an authorized internal billing domain workflow.
 */
export async function verifyStripeInvoiceFinalization(
  stripe: Pick<Stripe,'invoices'>,
  input: { invoiceRef: string; stripeCustomerId: string },
): Promise<{
  invoiceRef: string;
  finalizationVerified: true;
  creditApplicationVerified: false;
}> {
  if (!input.invoiceRef.startsWith('in_') || !input.stripeCustomerId.startsWith('cus_'))
    throw new Error('SPLIT08_INVOICE_LOOKUP_INPUT_INVALID');
  const invoice = await stripe.invoices.retrieve(input.invoiceRef);
  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer : invoice.customer?.id;
  if (invoice.id !== input.invoiceRef || customerId !== input.stripeCustomerId)
    throw new Error('SPLIT08_INVOICE_CUSTOMER_MISMATCH');
  if (invoice.status !== 'paid' || invoice.amount_remaining !== 0)
    throw new Error('SPLIT08_INVOICE_NOT_TERMINAL_PAID');
  // Stripe invoice payment confirms its payment status, NOT that a specific
  // one-unit noncash Partner Credit allocation changed invoice economics.
  return {
    invoiceRef:invoice.id,finalizationVerified:true,creditApplicationVerified:false,
  };
}
