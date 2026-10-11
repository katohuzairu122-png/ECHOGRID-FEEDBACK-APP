# Split 08 — Cross-Tenant Integrity, Stripe Invoice Preflight and Consumption/Reversal Race Gate

**Status: partial implementation. CE-1 authority freeze and economic activation withheld.**

## Changes
- `Split08Ce1TenantIntegrityVerifier.inspect` reads the reservation and supporting settlement, decision, lot, account, application and subscription through a transaction with settlement-first locking. It rejects cross-business or inconsistent record relationships and terminal timestamps. Passing returns `providerVerified:false`: structural database consistency is not proof of a credit benefit applied to a Stripe invoice.
- `verifyStripeInvoiceFinalization` retrieves an invoice directly from the authenticated Stripe client and requires the expected invoice ID, Stripe customer ID, `paid` status, `paid=true` and zero remaining amount. It returns `creditApplicationVerified:false` regardless of result. This is an independent **read-only preflight**, not a consumed-credit authorization or application writer.
- Tests include negative customer/payment-state preflight, synthetic PostgreSQL mismatched subscription owner, account owner, reservation business and positive matched structure that remains provider-unverified. Synthetic rows exist in the disposable isolated database only; 0041/0042 triggers remain enabled elsewhere.

## Explicit missing authority
- A paid Stripe invoice does not say one Partner Credit was applied. An immutable provider-verified noncash benefit/application reconciliation, invoice intent authorization and subscription/invoice-period policy are not present.
- The PostgreSQL consistency verifier is not itself a consumption writer, cannot independently prove provider finalization, and must never be exposed as a trust-granting API endpoint.
- Reservation writer remains internal and barred by 0041/0042; release remains denied without authoritative cancellation proof.
- The existing Split 06 reversal transaction locks the settlement first and fails closed on reserved or consumed lots. This PR does not implement terminal consume/release, consumed-credit recovery obligations, or execute a full concurrent consumption-versus-reversal race. Separate race and audit proof remain mandatory before freeze.
- 0042 currently enforces FK and uniqueness but **not composite cross-table tenant FKs**; this implementation performs a read-only transactional check, not a database-enforced universal invariant. Before activating any writes, add reviewed composite FK/constraint or DB trigger hardening and least-privilege write boundaries.

## Review and release gates
Confirm exact-head full CI and dedicated PostgreSQL tests, independent Stripe API version contract, real provider reconciliation rather than string existence, transaction isolation and locking diagrams, tenant-tampering negative tests, cancellation/reversal/application collision under concurrent independent DB connections, ledger/account/lot conservation, and fresh PostgreSQL compatibility.

**No production migration, no Stripe write, no invoice mutation, no trigger removal, no backfill, no scheduler, no live credit issue/consume.** Split 07 Block 2 completion lock remains withheld.
