import type Stripe from 'stripe';
import { describe, expect, it } from 'vitest';
import { verifyStripeInvoiceFinalization } from '../src/billing/stripe-invoice-finalization.verifier';

function stripeInvoiceRecord(overrides: Record<string, unknown> = {}): Pick<Stripe,'invoices'> {
  const record = {
    id:'in_test_invoice',customer:'cus_owner',status:'paid',
    amount_remaining:0,...overrides,
  };
  return {invoices:{retrieve:async()=>record}} as unknown as Pick<Stripe,'invoices'>;
}
describe('Split 08 Stripe invoice authority is not Partner Credit application authority',()=>{
  it('confirms terminal paid invoice but explicitly refuses to assert credit application',async()=>{
    await expect(verifyStripeInvoiceFinalization(stripeInvoiceRecord(),{
      invoiceRef:'in_test_invoice',stripeCustomerId:'cus_owner',
    })).resolves.toEqual({
      invoiceRef:'in_test_invoice',finalizationVerified:true,
      creditApplicationVerified:false,
    });
  });
  it('rejects customer mismatch and unpaid/unfinalized invoice',async()=>{
    await expect(verifyStripeInvoiceFinalization(stripeInvoiceRecord(),{
      invoiceRef:'in_test_invoice',stripeCustomerId:'cus_other',
    })).rejects.toThrow('SPLIT08_INVOICE_CUSTOMER_MISMATCH');
    await expect(verifyStripeInvoiceFinalization(stripeInvoiceRecord({status:'open'}),{
      invoiceRef:'in_test_invoice',stripeCustomerId:'cus_owner',
    })).rejects.toThrow('SPLIT08_INVOICE_NOT_TERMINAL_PAID');
    await expect(verifyStripeInvoiceFinalization(stripeInvoiceRecord({status:'open'}),{
      invoiceRef:'in_test_invoice',stripeCustomerId:'cus_owner',
    })).rejects.toThrow('SPLIT08_INVOICE_NOT_TERMINAL_PAID');
    await expect(verifyStripeInvoiceFinalization(stripeInvoiceRecord({amount_remaining:50}),{
      invoiceRef:'in_test_invoice',stripeCustomerId:'cus_owner',
    })).rejects.toThrow('SPLIT08_INVOICE_NOT_TERMINAL_PAID');
  });
  it('rejects invalid invoice/customer references before querying Stripe',async()=>{
    await expect(verifyStripeInvoiceFinalization(stripeInvoiceRecord(),{
      invoiceRef:'fake',stripeCustomerId:'cus_owner',
    })).rejects.toThrow('SPLIT08_INVOICE_LOOKUP_INPUT_INVALID');
  });
});
