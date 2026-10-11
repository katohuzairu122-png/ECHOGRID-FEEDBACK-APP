# Split 08 — Invoice Benefit Application Evidence and Consumption/Reversal Concurrency Gate

**Disposition: PARTIAL. CE-1 freeze and Split 07 final completion lock WITHHELD.**

## Verified sources and gaps
- Existing Stripe webhook handler processes `customer.subscription.*` only. It synchronizes a subscription mirror and does **not** establish that Partner Credits were applied to any invoice.
- Existing read-only Stripe invoice finalization verifier checks payment/customer and explicitly reports `creditApplicationVerified: false`.
- A row in `billing_partner_credit_applications`, including `terminal_state = 'applied'` and a `provider_success_ref`, is **not provider evidence**. Migration 0042's inert guard denies writes outside isolated test databases.
- Reservation is Split 07-owned and distinct from Split 08's invoice/benefit effect. Existing candidate reservation writer has no approved invoice-intent authority. Split 06 reversal is authoritative and holds settlement locks.

## Implemented race gate
A new isolated PostgreSQL test advances an actual award into vested state, runs Partner Credit reservation and an authorized Split 06 reversal simultaneously on two independent database connections, and verifies **one of two permitted serial outcomes**:
1. Reservation locks and commits first: credit stays reserved; settlement reversal rolls back, no reversal event, no account double debit.
2. Reversal locks and commits first: settlement and award reverse; reservation fails, no reservation record and no reserved balance.
The test disables only the existing reservation write-denial trigger on disposable CI PostgreSQL, then re-enables it in `finally`. It does not create a terminal application, remove production guards, or simulate Stripe money.

## Missing *authoritative* application proof
Before any production terminal consumption writer, Split 08 must own and freeze:
1. An invoice-intent authorization and immutable subscription-period policy that defines whether and how one noncash Partner Credit changes the invoice amount. Tax, proration, yearly billing, refunds and applicable payment states require explicit rules.
2. A provider-confirmed billing effect: exact invoice and customer/subscription IDs, eligible finalized line/discount/credit attribution, gross/net/tax accounting evidence, applied unit and noncash benefit mapping, terminal timestamp, and stable idempotency reference. Provider `paid` status and arbitrary invoice metadata are insufficient.
3. A restricted, trusted database-queryable source, linked to the Split 07 reservation/lot/decision/business, that cannot be created by client assertions, unverified webhook fields or staff edits.
4. **One atomic credit transition** under settlement-first compatible locks: reserved -> consumed, account reserved decrement, immutable application entry, durable idempotency, and rollback for any mismatch. Stripe operations are external; use an explicit provider reconciliation/saga protocol, never pretend a database transaction atomically includes Stripe.
5. Real Postgres parallelism: consumption vs reversal, consumption vs release, webhook duplicate/reordering, application after reservation expiration, provider success but database failure, and retries after partial transport failure. Verify conserved original credit ledger and future noncash recovery obligations when Split 06 legitimately reverses consumed credits.

## Current safety
- No CE-1 production activation, no Stripe write, no new migration, no backfill, no cash debit, no Community Point or loyalty mutation.
- Existing 0041/0042 guard triggers are unchanged.
- Split 06 reversal continues to **reject reserved/consumed lots** rather than fabricate a recovery obligation.
- Passing the new reservation-vs-reversal test does **not** constitute consumed-credit vs reversal concurrency completion.

**Next required stage:** Split 08 frozen invoice-benefit economic contract and authoritative provider reconciliation; then a gated terminal consumption saga and Split 07 verified consumed-credit recovery writer.
