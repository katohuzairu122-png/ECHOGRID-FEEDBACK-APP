# Echo Grid Commercial Policy

Prices are stored in integer cents. Matching recurring Stripe Price IDs must be connected through the platform plan editor before a paid plan can be purchased.

## Plan catalog

| Plan | Monthly | Annual | Responses/month | Branches | Users | Included |
|---|---:|---:|---:|---:|---:|---|
| Free | $0 | — | 25 | 1 | 1 | Basic feedback collection |
| Starter | $9 | $90 | 1,000 | 1 | 3 | Feedback collection and core reporting |
| Growth | $29 | $290 | 5,000 | 5 | 10 | Starter plus AI summaries |
| Business | $59 | $590 | 20,000 | 15 | 30 | Higher limits, AI insights, and custom branding |
| Enterprise | Custom | Custom | Custom | Custom | Custom | Custom onboarding, limits, and support |

Annual paid pricing provides two months at no additional charge compared with twelve monthly payments. Plan keys remain stable if display names change.

## Trial and free access

Every new business receives a 14-day cardless Starter trial with the Starter allowance. A business that does not purchase a paid plan can use the Free allowance of 25 responses per month. Existing feedback remains available when an allowance is reached.

## Payment failure and grace period

Stripe is the payment system of record. A failed renewal moves the mirrored subscription through Stripe's `past_due` and, if recovery fails, `unpaid` states. Echo Grid allows a seven-day operational grace period while Stripe retries payment. The application does not delete customer data because of a payment failure.

## Downgrades and cancellation

Paid plan changes and cancellations use Stripe's hosted Customer Portal. Downgrades and cancellations take effect at the end of the paid billing period. Enterprise customers contact sales for a tailored agreement.

## Refunds

Charges are non-refundable after a billing period starts except where required by law or when Echo Grid confirms a duplicate or erroneous charge.

## Currencies, tax, and invoices

The initial catalog is USD only. Stripe-hosted Checkout and the Customer Portal handle payment details and invoice delivery; Echo Grid does not store card data. No additional currency is offered until matching Stripe Prices and display amounts are added together.
