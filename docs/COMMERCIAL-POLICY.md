# Echo Grid Commercial Policy

This policy fixes the launch defaults used by the Block 2G commercial-readiness gate. Prices are stored in integer cents and the matching recurring Stripe Price IDs must be assigned through the platform plan editor before a plan can be purchased.

## Plan catalog

| Plan | Monthly | Annual | Branches | Users | Included |
|---|---:|---:|---:|---:|---|
| Starter | $29 | $290 | 1 | 3 | Feedback and core reporting |
| Growth | $99 | $990 | 10 | 25 | Starter plus AI summaries |
| Enterprise | $299 | $2,990 | Unlimited | Unlimited | Growth plus custom branding |

Annual pricing provides two months at no additional charge compared with twelve monthly payments. Plan keys remain stable if display names change.

## Trial

Every new business receives a 14-day cardless Starter trial. Checkout is optional during the trial. A business without a Stripe customer cannot open the Customer Portal and receives `NO_STRIPE_CUSTOMER`.

## Payment failure and grace period

Stripe is the payment system of record. A failed renewal moves the mirrored subscription through Stripe's `past_due` and, if recovery fails, `unpaid` states. Echo Grid allows a seven-day operational grace period while Stripe retries payment. Owners can update payment details through the Customer Portal. Support reviews accounts that remain unpaid; the application does not delete customer data because of a payment failure.

## Downgrades and cancellation

Plan changes and cancellations use Stripe's hosted Customer Portal. Downgrades and cancellations take effect at the end of the paid billing period, preserving access already purchased. The webhook mirrors `cancel_at_period_end`, cancellation time, plan, interval, and period dates. Reactivation before period end is handled in the Portal and synchronized by the next subscription update.

## Refunds

Charges are non-refundable after a billing period starts except where required by law or when Echo Grid confirms a duplicate or erroneous charge. Support records approved exceptions and processes them in Stripe. Cancellation prevents future renewal and does not itself refund the current period.

## Currencies, tax, and invoices

The initial catalog is USD only. Stripe-hosted Checkout and the Customer Portal handle payment details and invoice delivery; Echo Grid does not store card data. Tax registration, tax rates, invoice identity, and any Stripe Tax activation are configured in the Stripe account for the seller's jurisdictions before paid launch. No additional currency is offered until matching Stripe Prices and display amounts are added together.
