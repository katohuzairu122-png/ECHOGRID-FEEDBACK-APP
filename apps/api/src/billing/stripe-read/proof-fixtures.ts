/**
 * S08-D1D3-DEV-09: REPRODUCIBLE SYNTHETIC proof fixtures. One deterministic, Stripe-shaped response per read, written to exercise every mapped field of the SDK profile (both line parent variants, a
 * payment-intent and a charge payment, a refund addressed by payment intent and by charge, a dispute). They are constants, not recordings: they contain no real identifier and prove nothing about what Stripe
 * returns. A proof built from them is at best SYNTHETIC_FIXTURE and can never raise a mapping status.
 */
export const PROOF_ACCOUNT_ID = 'acct_ProofSyntheticAccount1';
export const PROOF_INVOICE_ID = 'in_ProofSyntheticInvoice1';
const PI = 'pi_ProofSynthetic1';

export const syntheticProofResponses = () => ({
  ACCOUNT_RETRIEVE_CURRENT: { object: 'account', id: PROOF_ACCOUNT_ID },
  INVOICE_RETRIEVE: {
    id: PROOF_INVOICE_ID, object: 'invoice', livemode: false, currency: 'usd', status: 'paid', customer: 'cus_ProofSynthetic1',
    parent: { type: 'subscription_details', quote_details: null, subscription_details: { subscription: 'sub_ProofSynthetic1' } },
    amount_due: 2700, amount_paid: 2700, amount_remaining: 0, total: 2700, created: 1_700_000_000,
    status_transitions: { finalized_at: 1_700_000_001, marked_uncollectible_at: null, paid_at: 1_700_000_100, voided_at: null },
    lines: { object: 'list', has_more: false, data: [{ id: 'il_ProofBase1', amount: 3000, currency: 'usd' }, { id: 'il_ProofBenefit1', amount: -300, currency: 'usd' }] },
  },
  INVOICE_LINES_LIST: {
    object: 'list', has_more: false, url: '/v1/invoices/in_ProofSyntheticInvoice1/lines',
    data: [
      { id: 'il_ProofBase1', object: 'line_item', amount: 3000, currency: 'usd', invoice: PROOF_INVOICE_ID, livemode: false, metadata: {}, parent: { type: 'subscription_item_details', invoice_item_details: null, subscription_item_details: { invoice_item: null, proration: false, subscription: 'sub_ProofSynthetic1', subscription_item: 'si_ProofSynthetic1' } } },
      { id: 'il_ProofBenefit1', object: 'line_item', amount: -300, currency: 'usd', invoice: PROOF_INVOICE_ID, livemode: false, metadata: { note: 'synthetic' }, parent: { type: 'invoice_item_details', subscription_item_details: null, invoice_item_details: { invoice_item: 'ii_ProofSynthetic1', proration: false, subscription: 'sub_ProofSynthetic1' } } },
    ],
  },
  PAYMENT_RETRIEVE: {
    object: 'list', has_more: false, url: '/v1/invoice_payments',
    data: [
      { id: 'inpay_ProofSynthetic1', object: 'invoice_payment', amount_paid: 2700, amount_requested: 2700, created: 1_700_000_050, currency: 'usd', invoice: PROOF_INVOICE_ID, is_default: true, livemode: false, payment: { type: 'payment_intent', payment_intent: PI }, status: 'paid', status_transitions: { paid_at: 1_700_000_100, canceled_at: null } },
      { id: 'inpay_ProofSynthetic2', object: 'invoice_payment', amount_paid: null, amount_requested: 2700, created: 1_700_000_040, currency: 'usd', invoice: PROOF_INVOICE_ID, is_default: false, livemode: false, payment: { type: 'charge', charge: 'ch_ProofSynthetic1' }, status: 'canceled', status_transitions: { paid_at: null, canceled_at: 1_700_000_045 } },
    ],
  },
  REFUNDS_LIST: {
    object: 'list', has_more: false, url: '/v1/refunds',
    data: [
      { id: 're_ProofSynthetic1', object: 'refund', amount: 500, charge: 'ch_ProofSynthetic1', created: 1_700_000_200, currency: 'usd', payment_intent: PI, status: 'succeeded' },
      { id: 're_ProofSynthetic2', object: 'refund', amount: 100, charge: 'ch_ProofSynthetic1', created: 1_700_000_300, currency: 'usd', payment_intent: null, status: 'pending' },
    ],
  },
  DISPUTES_LIST: {
    object: 'list', has_more: false, url: '/v1/disputes',
    data: [{ id: 'dp_ProofSynthetic1', object: 'dispute', amount: 2700, charge: 'ch_ProofSynthetic1', created: 1_700_000_400, currency: 'usd', livemode: false, payment_intent: PI, status: 'needs_response' }],
  },
});
