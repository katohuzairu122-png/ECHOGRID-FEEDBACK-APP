# Split 08 — Invoice Benefit Economics Freeze & Provider Reconciliation Gate

**Decision: ECONOMIC POLICY NOT FROZEN. TERMINAL CONSUMPTION DENIED.**

## Reconciliation
Split 07 owns one-unit noncash Partner Credits, their award/vesting/expiry, reserved and available buckets and noncash recovery. Split 08 owns invoice monetary effects, subscription billing, Stripe provider reconciliation, and the terminal billing application source. Split 06 owns fulfillment and reversal. These authorities must remain separate.

The current Stripe webhook service mirrors only subscription events. The existing read-only Stripe invoice verifier confirms paid/customer identity but explicitly does not confirm any Partner Credit benefit. Migration 0042's `billing_partner_credit_applications` is an inert structural table. Its `provider_success_ref` string is not independently verified invoice-effect evidence. The 0041 and 0042 mutation barriers are installed and must remain so.

## Economic choices requiring *actual* billing approval
Do not hardcode any monetary value or inference from the one-unit Partner Credit. The policy owner must specify and sign off on:
- Benefit value in currency minor units for **one noncash credit**, supported billing currency/currency mismatch handling, and version/effective date.
- Whether monthly, yearly, or both invoice intervals qualify, and which finalized line-item amounts are eligible.
- Tax basis and order (pre-tax discount vs post-tax credit), tax reporting, proration and annual subscription treatment.
- Trial, free, canceled, past-due, paid, partially-paid, no-amount-due and invoice-adjustment eligibility.
- Max eligible invoice benefit and whether excess is rejected, capped or remains unconsumed.
- Refunds, disputes, canceled invoices, reversals after consumption, provider credit notes and historical application retention.
- Policy change handling, rollout/rollback, approval evidence and platform-admin permissions.

The included pure policy-review function flags missing choices. A complete candidate is **NOT** proof of the signer's authority or a frozen version.

## Provider-reconciled application source required
Before a credit becomes consumed, Split 08 must verify directly from the provider:
1. Exact Stripe invoice, customer and subscription IDs matching a current authorized business subscription and applicable billing period.
2. Paid/finalized invoice and an **individually attributable** approved benefit adjustment/discount/credit note or invoice-line effect whose amount and currency reconcile to the signed policy and eligible invoice base.
3. Immutable source reference, actual effect amount, timestamps, policy version, and a distinct idempotency key linked to exactly one Split 07 reservation/decision/lot and terminal application.
4. Re-query/reconcile provider data in a privileged server workflow; raw webhook payloads, metadata, client assertions, synthetic rows and payment status alone are insufficient.
5. Define a durable provider-to-database saga and recoverable status sequence for provider success followed by database unavailability, transient errors, duplicate deliveries and refunds. Stripe and PostgreSQL are **not** one atomic transaction.

## Terminal consumption transaction, blocked pending prior gates
After authoritative provider reconciliation, the future Split 08 consumer and Split 07 credit writer must coordinate a settlement-first lock order, then decision, lot, account, reservation, subscription, and application. In one PostgreSQL transaction:
- Revalidate settlement/claim, vested unexpired unit, no reversal, reserved ownership and deadline, zero incompatible recovery debt and exact allocation to business/lot/subscription.
- Bind a **verified** source of benefit-adjustment evidence to a unique, immutable terminal application.
- Transition reservation reserved → consumed, lot reserved → consumed, decrement account reserved by one, and preserve ledger/account/lot conservation.
- Replays return the same terminal reference, never reapply benefits. Failed verification rolls back all database economic movement. Paid-but-unapplied invoices must **not** consume credits.
- Split 06 reversal after consumption must preserve historical invoice effects and call a Split 07 compensating obligation writer only after the original Split 08 evidence is independently verifiable. Partial/reserved/unverified states fail closed.

## Status of this PR
Only pure, non-authorizing candidate review functions, tests and this review specification are added. No new provider adapter, billing adjustment, economic policy, Stripe mutation, database migration, consumption writer, obligation writer, routes, triggers, backfill, activation, or credential configuration.

**Release disposition:** architecture review only; final consumption/CE-1 economic freeze, Split 07 Block 2 completion lock, and production Partner Credit issuance/consumption remain **WITHHELD**.

**Next necessary decision:** approve or reject the explicit monetary, tax, invoice-eligibility and refund policy, then implement a provider-confirmed benefit attribution and durable reconciliation ledger. Without those, a terminal consumption writer would introduce fabricated economic authority.
