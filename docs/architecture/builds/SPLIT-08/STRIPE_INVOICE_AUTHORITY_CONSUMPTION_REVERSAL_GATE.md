# Split 08 — Stripe Invoice Read Authority, Consumption/Reversal Gate

**Stage status: read-only authority probe + negative tests; full consumption not authorized.**

## Inspected existing race evidence
The isolated PostgreSQL suite already tests concurrent Split 06 reversal versus Split 07 reservation: settlement-first locking serializes the race. If reservation wins, reversal rejects and settlement remains fulfilled; if reversal wins, the reservation rejects and no credit is stranded. This does **not** constitute a consumption-vs-reversal test because the terminal consumption writer does not yet exist.

## Stripe provider authority adapter
`PartnerCreditStripeInvoiceAuthorityAdapter.inspect` retrieves an invoice from Stripe's server-side SDK using the expected ID from tenant-checked internal records. It rejects missing/malformed identities, non-paid/test-mode invoices, nonzero amount remaining, and customer/subscription mismatch. Even an invoice whose payment and identity are confirmed returns `invoice_verified_credit_unproven`: it does not certify that a Partner Credit benefit was actually applied. Stripe customer/subscription objects and invoice references alone cannot prove that specific credit adjustment.

The invoice's parent subscription details are used for the pinned Stripe API shape; account/provider API schema compatibility must be validated separately before operational use. This adapter is not wired to webhooks, billing routes or a consumer.

## Consumption write gate (withheld)
Before an atomic consumer is enabled, Split 08 must freeze a provider-authoritative credit application instrument with provenance tied to the invoice and one reservation. A provider-confirmed invoice alone does not establish that provenance. The eventual transaction must follow settlement → decision → lot → account → reservation/application ordering compatible with Split 06 reversal, and must fail closed on already-reversed settlements, duplicate application, released/expired reservations, mismatched tenant, and provider staleness. Its reserved→consumed projection and immutable evidence insert must be atomic; provider API calls must not occur while database rows are locked. Replay returns the original terminal result. Distinct lock-safe cancellation and refund policy is also pending.

Until those prerequisites exist, no consumption writer, consumption-vs-reversal integration test, or consumed-credit recovery obligation writer may claim successful end-to-end authority. Existing reservation-vs-reversal PostgreSQL tests remain required regressions.

## Activation decision
Keep 0041/0042 mutation guards active. No balance, subscription, invoice, Stripe, Community Point or loyalty changes. No CE-1 freeze; Split 07 final completion gate remains blocked.
