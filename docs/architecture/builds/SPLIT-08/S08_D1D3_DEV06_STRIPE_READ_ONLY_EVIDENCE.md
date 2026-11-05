# S08 D1/D3-DEV-06 — Trusted Stripe read-only evidence integration (development record)

Status: DEVELOPMENT ONLY, INERT. Financial activation: NO-GO. No Stripe call is made by anything in this repository outside tests; tests use a scripted transport and an injected fake `fetch`. No migration. Code: `apps/api/src/billing/stripe-read/`.

## Capability registry (closed, frozen, GET-only, test-mode-only)
| Method id | Path | State |
| --- | --- | --- |
| `ACCOUNT_RETRIEVE_CURRENT` | `GET /v1/account` | APPROVAL_REQUIRED |
| `INVOICE_RETRIEVE` | `GET /v1/invoices/{id}` | APPROVAL_REQUIRED |
| `INVOICE_LINES_LIST`, `PAYMENT_RETRIEVE`, `REFUNDS_LIST`, `DISPUTES_LIST` | — | NOT_AUTHORIZED (Q1/Q2): no transport path exists, no configuration enables them |

The inventory (S08-STRIPE-PRIVATE-TEST-VERIFIER-001) records the two operations as **PENDING APPROVAL**. They therefore work only while a supplied `ReadAuthorization` (current, unrevoked, unexpired, test realm, approved `acct_*`, names the method) allows them; with none, the adapter makes no provider call. No real call has been made, and real-provider verification is BLOCKED pending that approval, a restricted TEST key and workload execution authorization.

## Layers
- `transport.ts` — the only code that can reach Stripe: GET on two fixed paths, `rk_test_/sk_test_` keys only, pinned `Stripe-Version: 2026-05-27.dahlia`, no `Stripe-Account`, redirects refused, timeout, size cap, fixed-code errors (no body, header, URL or key). Not the Stripe SDK client.
- `invoice-normalizer.ts` — strict typed normalization. Identity (object, invoice id, test realm, customer/subscription binding) are denials; every other fact is VERIFIED, CONFIRMED_ABSENT, UNRESOLVED or CONTRADICTORY with its origin and mapping status. Nothing is defaulted, coerced or repaired.
- `bundle-builder.ts` — assembles evidence; `complete` and `stable` are computed here only; the digest is canonical and independent of the observation instant (idempotent duplicate retrieval).
- `adapter.ts` — `acquire(scope)`: capability check for both methods, account must equal the approved account before any invoice read, two bracketing invoice reads, server-clock observation time, audit events (codes and ids only), sealed `STRIPE_TEST_READ` result.
- `evidence-origin.ts` — origin is the object's registration in a module-private `WeakMap`, not a field: clones, JSON round trips and edited objects are unsealed and refused.
- `classifier-bridge.ts` — connects to the unchanged D1 and D3 classifiers. Only `MOCK_FIXTURE` evidence is converted; real evidence reaches the classifier labelled with an evidence kind it does not accept, so it answers `UNRESOLVED / EVIDENCE_KIND_UNSUPPORTED` itself. Uncertainty becomes "unknown", never "none".
- `trusted-evidence-service.ts` — enforces the S08-PV05 invocation contract for both operations, the persisted tenant scope (`resolveScope`), and refuses any caller-supplied property beyond `businessId`/`invoiceId`. Wired to no route or Worker (the private verifier stays an inert 404).
- `mock-provider.ts` — the full anticipated evidence set for development, sealed `MOCK_FIXTURE`; `ScriptedReadTransport` for tests.

## Field mappings (shape from the pinned Stripe SDK type definitions; NOT proven live — Q1/Q2)
Mapped from `GET /v1/invoices/{id}`: `id`, `object`, `livemode`, `currency`, `status`, `customer`, `parent.subscription_details.subscription`, `amount_due/paid/remaining`, `total`, `created`, `status_transitions.paid_at/voided_at`, embedded `lines.data[].{id,amount,currency}` + `lines.has_more`. Everything else is UNRESOLVED for real reads: line category/parent item/parent idempotency key, billing interval, benefit invoice item, cancellation, settling payment, refunds, disputes. The SDK in the lockfile is 22.3.2 (API version 2026-06-24.dahlia) while the pin is 2026-05-27.dahlia, so even mapped fields need live confirmation.

## Consequences
A real read can never be complete and can never reach ELIGIBLE or a recorded authorization: the recorder and the database `evidence_kind` CHECK accept only the mock kind. DEV-03 gate, DEV-04 database authority and DEV-05 key registry are untouched.

## Not built / still open
Approval of the two reads; a restricted TEST key and its custody; execution authorization and mounting in the private Worker; source-supported mappings and reads for lines, payment, refunds, disputes (Q1/Q2); a real evidence envelope accepted by the classifiers; Q3, Q12, Q14; refund recovery; R10.
