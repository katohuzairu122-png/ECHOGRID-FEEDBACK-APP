# Owner decision: Split 08 negative invoice item and attribution — 2026-10-25

**Decision ID: S08-INSTRUMENT/1. Status: instrument and attribution design approved for development only.**

## Approval evidence

The repository owner approved this proposal in the current work session:

> One negative Stripe invoice item per reservation, attached to the explicit draft invoice using the existing reservation-derived idempotency key. Attribution requires the authorized persisted intent plus independently retrieved invoice-item/line references; metadata alone never establishes authority. Tax treatment, rounding, final accounting, and all actual Stripe writes remain blocked.

The owner selected **“Approve instrument and attribution design.”** This record captures that selection, not a production authorization or separate identity attestation. It supplements [S08-TIMING/1](OWNER_DECISION_S08_DRAFT_INVOICE_TIMING_2026-10-25.md).

## Approved instrument design

- One negative Stripe **Invoice Item** represents the approved benefit for one Partner Credit reservation.
- Its creation request must explicitly name the already-bound draft invoice and customer, use the expected currency, and carry exactly the negative of the approved per-reservation benefit amount.
- The invoice remains the one named by the persisted intent. Omitting the invoice, creating a pending item for an unspecified future invoice, changing subscriptions, or falling back to another invoice is not approved.
- Preserve the existing stable operation identity: `benefit-apply:v1:<reservationId>`. A timeout does not permit a replacement key or a second economic action.
- Validate the entire S08-PIC/1 identity tuple, authorization, invoice lifecycle and scope immediately before any future separately authorized mutation.
- Return/persist the provider operation reference as evidence of the attempted operation only. It never authorizes ledger consumption.

This selects the intended Stripe object and attribution design. It adds no adapter, Stripe SDK write call, route, cron, queue or invocation.

## Approved attribution design

1. Begin with the authenticated, authorized persisted intent and its reservation, business, policy, exact amount/currency and provider account/mode/customer/subscription/invoice binding. A caller-supplied tuple is insufficient.
2. Durably bind the attempted operation and any returned Invoice Item reference to that intent and stable operation key, rejecting conflicting identities. A provider response alone is not a reconciled effect.
3. Independently retrieve provider evidence under the same verified account/mode. Read the target invoice and its complete line list; independently retrieve the relevant Invoice Item where required to establish its identity and relationship.
4. Correlate the Invoice Item reference and its generated invoice line reference through provider-reported parent identity. Match both to the authorized intent, reservation, invoice, customer, subscription context, exact amount/currency and policy.
5. Metadata may corroborate the reservation/intent identity but must never create authority or substitute for the server-side operation binding and independently verified provider references.
6. Unknown, conflicting, incomplete, duplicated or unattributed evidence retains the pending obligation. Candidate-metadata absence cannot certify absence of a possible economic effect.
7. If an operation response is lost, recover the original operation identity and independently reconcile the effect. Do not invent a provider reference or treat a second submission as a new action.

The existing read-only reconciliation remains authoritative. The current candidate extractor and reader do **not** yet implement the full approved attribution design; notably, matching metadata alone is insufficient. Preserve the boundary and extend evidence handling only within subsequent authorized development scope.

## Decisions still open

- **Economic/tax treatment:** tax basis/behavior, inherited taxes, interaction with existing invoice discounts and discountability. Do not silently accept provider defaults as approval.
- **D2:** aggregate versus per-credit rounding, deterministic residual allocation, exact per-reservation amounts and aggregate cap enforcement.
- **D3:** authoritative settlement evidence and detailed eligibility, including partial/zero payment, annual periods, proration, out-of-band settlement, cancellation and refunds.
- **D4:** frozen-compatible final ledger vocabulary, transactional consumption, conservation/lock order and separately authorized compensation.
- Versioned policy/effective scope and remaining full authenticated identity-binding implementation.

This approval does not choose any of these behaviors. Dependent implementation remains stopped at unresolved economic or frozen-architecture decisions under S08-PIC/1 section G.

## Development acceptance implications

Future non-activating development must prove: explicit invoice targeting; full authorized identity checks; preservation of the original operation key; exact approved amount; provider Invoice Item-to-line correlation independent of metadata; complete evidence; finalization races; lost responses and crash recovery; duplicate effects and cross-business substitution.

Final ledger consumption additionally requires independent benefit reconciliation, settlement, and every section D gate. An internal saga `consumed` status does not satisfy that contract by itself.

No acceptance scenario is certified by this decision record.

## Provider documentation checked

- [Create an Invoice Item](https://docs.stripe.com/api/invoiceitems/create): a negative amount reduces the invoice amount due; an explicit invoice targets that invoice, while omission would defer the item to a future invoice.
- [Invoice Line Item object](https://docs.stripe.com/api/invoice-line-item/object): the parent invoice-item relationship provides the provider linkage to verify independently.

These sources establish API capabilities. They do not approve ECHO GRID's economic, tax or accounting policy, or authenticate its provider evidence.

## Release restrictions

Development design only. S08-PIC/1 remains Proposed. No actual Stripe benefit writes (test or live), production financial activation, credit consumption, compensating financial execution, production migration, deployment or certification.

No production guard, role, credential or authorization flag changes. `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain unchanged. Merging this record grants no additional approval.
