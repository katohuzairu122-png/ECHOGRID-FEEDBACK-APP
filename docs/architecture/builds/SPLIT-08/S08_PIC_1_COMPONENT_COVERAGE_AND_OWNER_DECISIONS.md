# S08-PIC/1 component coverage and owner decisions — 2026-10-25

**Status: draft-invoice timing plus negative Invoice Item/independent attribution design approved for development only; remaining economic decisions unresolved. NO provider-write or production authorization.**

This supplements the [readiness review](S08_PIC_1_READINESS_REVIEW.md) and leaves [S08-PIC/1](PROVIDER_INTEGRATION_CONTRACT_S08_PIC_1.md) unchanged. Baseline: `main` at `f2c0a5429c1903911a3cbc0c5a6d75ea82f6bf83`, after PR #174.

## What the integration proves

The [passing integration-PR CI run](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/40189320642) validated head `4705c4eafa2142c0c19ac730bffad772f700f30f` combined with then-current main: installation, audit, lint, typechecks, unit tests, disposable migrations, HETA verifier, integration tests, builds and browser checks. The integration suite reported 447 passed / 21 skipped. A skipped test is not evidence of a passed requirement.

The provider tests use fake clients; the persistence tests use disposable databases. The saga's internal `consumed` state is a reconciliation state and is not a Partner Credit ledger commit. This packet neither performs additional runtime tests nor certifies any of the 17 end-to-end scenarios.

## Evidence references

Paths below are relative to the repository root. Test descriptions identify the component assertions reviewed.

- **A**: `apps/api/src/billing/provider-effect.adapter.test.ts` — read-only fake-provider scope, pagination, attribution, error classification and reader binding tests.
- **R**: `apps/api/test/integration/benefit-reconciliation.integration.test.ts` — real disposable PostgreSQL with fake provider, repeated absence, durable attempts, recovery, holds and unchanged credit balances.
- **S**: `apps/api/test/integration/benefit-application-saga.integration.test.ts` — inert persistence, intent replay/conflicts, concurrency, tenant keys, declarative reversal effects and unchanged credit balances.
- Implementation boundaries: `benefit-application.saga.service.ts`, `benefit-reconciliation.service.ts`, `provider-effect.adapter.ts` and `stripe-invoice-reader.ts` under `apps/api/src/billing/`.

## All 17 activation scenarios

**Every row remains NOT CERTIFIED.** “Component evidence” means the named assertion exists in the reviewed suite, not that a production financial path or a real Stripe instrument was exercised.

| Required scenario | Component evidence reviewed | Missing end-to-end evidence |
| --- | --- | --- |
| Duplicate submission | S: identical intent terms replay; conflicting terms fail; repeated observations do not change state twice. | A provider-write boundary must enforce one economic action and a separately authorized finalizer must enforce one ledger commit. |
| Concurrent application attempts | S: many simultaneous attempts start once. R: simultaneous reconcilers issue one query while an attempt is in flight. | Concurrent authorized mutations and final consumption with conserved balances are not exercised. |
| Timeout after successful provider mutation | A classifies timeout errors; S/R cover abandoned durable attempts. | No mutating provider exists in these tests. Prove a provider committed while its response was lost, then recover without repeating the economic action. |
| Provider rate limitation | A: rate-limit type/status, Retry-After and backoff assertions. R: redacted persisted retry/error outcome holds the saga. | Prove the selected write instrument preserves original operation identity and the obligation across rate limits. |
| Wrong account or mode | A parameterized account/mode mismatch tests refuse invoice trust and line reads. R persists a wrong-account hold. | Establish the authenticated account/mode-to-business binding before mutation, then reject substitution at the complete boundary. |
| Cross-business substitution | S: composite tenant foreign keys reject child/intent/reservation business mismatches. A rejects customer/subscription mismatches. | These do not authenticate the full identity tuple or prove that a caller cannot supply another business's provider scope. |
| Incorrect invoice or currency | A parameterized invoice/currency mismatch tests; S rejects conflicting intent terms. | Revalidate immediately before the approved mutation and prevent substitution, conversion and ledger movement. |
| Wrong benefit amount | R: wrong-amount effect is held as disputed. S: mismatching observation does not confirm. | Prove mutation uses only the owner-approved allocated amount and cannot substitute an amount. |
| Unattributed benefit | S: an unattributed observation is retained. A ignores lines without the candidate reservation metadata. | Ignoring a line does not establish that no economic effect occurred. An approved instrument and authenticated attribution scheme must distinguish unverifiable effects from proven absence. |
| Partial pagination | A: later-page effect found; page cap, unpageable hasMore and page failure do not establish absence. R forwards unverifiable results as holds. | Demonstrate complete independent evidence for the chosen instrument with no alternate success path through a partial response. |
| Unknown provider outcome | R: errors, incomplete/scope mismatch outcomes retain; one absent read does not release; broken absence streaks fail closed. | Recover an unknown mutating-provider outcome without new economic action or fabricated success. |
| Duplicate provider effect | R: two effects for one reservation are disputed. S: unique effect binding prevents one effect from settling two intents. | Prevent final ledger consumption while duplicates or competing attribution remain unresolved. |
| Reservation expiry | S: createIntent rejects an expired/non-reserved reservation. | Cover expiry between preparation and mutation and expiry while a provider outcome is unknown; retain any real obligation under the frozen rules. |
| Reversal during application | S: reversal while applying retains; a later effect records declarative compensation once. | The resulting internal state cannot bypass section D: unresolved reversal/compensation must block final consumption. Financial compensation needs separate authority. |
| Multiple credits targeting one invoice | A distinguishes other reservations' candidate lines. S prevents reuse of one provider effect across intents. | Owner-approved allocation/rounding and invoice aggregate cap checks under concurrency, without aliased effects or excess benefit. |
| Recovery after process crash | S: fresh service finds an abandoned attempt. R: unfinished attempt remains visible, breaks absence streak and permits later recovery. | Crash around provider mutation, observation persistence and final commit must preserve the same operation and produce no duplicate economic action. |
| Concurrent final settlement | S: concurrent saga confirmations are idempotent. | No authorized final ledger-consumption service exists. Prove exact-once transactional consumption plus settlement/dispute/reversal races and all conservation invariants. |

For all future acceptance fixtures, capture reservation, lot, account, immutable ledger and terminal application state before and after. Read-only retrieval and saga persistence must leave Partner Credit balances unchanged. An authorized finalizer must commit valid movements once and commit no financial movement after a failed gate. Existing component tests cannot substitute for these whole-path assertions.

## Owner decision record to complete

**D1/D3 timing is partially resolved for development only:** the owner selected option 1 in this work session: reduce the specific draft invoice before payment, with final consumption only after independent reconciliation and settlement. See the [timing decision record](OWNER_DECISION_S08_DRAFT_INVOICE_TIMING_2026-10-25.md). The owner subsequently approved one negative Invoice Item per reservation with persisted-intent authorization and independent Invoice Item/line-reference attribution. See [S08-INSTRUMENT/1](OWNER_DECISION_S08_NEGATIVE_INVOICE_ITEM_2026-10-25.md). Tax treatment, allocation, detailed settlement evidence and accounting remain unresolved; full authenticated binding is still an implementation gap.

**Remaining fields below are UNDECIDED.** This is a reviewable decision template, not an approval request to run production operations. A completed development decision does not authorize Stripe calls, guard removal, production migrations, deployment, credit consumption or compensation.

| Decision | Concrete fields the owner must approve | Work stopped at this boundary |
| --- | --- | --- |
| D1: Stripe benefit instrument and attribution | Negative Invoice Item per reservation explicitly targeting the draft invoice, original idempotency identity, authorized persisted intent and independent Invoice Item/line correlation are selected for development. Economic/tax treatment and policy version/effective scope remain open. The metadata-only candidate extractor is not sufficient. | No actual provider writes or instrument-specific absence certification. Do not choose unresolved tax/economic behavior; authenticated evidence binding remains unimplemented. |
| D2: Per-reservation amount allocation | Authoritative aggregate/per-credit calculation, rounding, deterministic residual allocation and ordering, invoice cap, currency and policy version. Specify each reservation's exact approved amount and the invariant relating their sum to the invoice benefit. | Do not choose residual allocation or pass arbitrary expected amounts as approved economic policy. |
| D3: Invoice settlement eligibility/evidence | Required finalized/paid/settled state and source fields for final consumption; draft-invoice application followed by independent reconciliation and settlement selected for development only; treatment of zero/partial payment, annual periods, proration, cancellation and later refund/dispute. Explicitly adopt or reject the previous testing-only defaults. | Do not promote test eligibility defaults or a provider success response into final-consumption authority. |
| D4: Consumption and compensation accounting | A reviewed transactional design within frozen Split 07/08 ownership, ledger vocabulary, lock order and conservation rules; the exact evidence and unresolved-obligation gates; separate authority for any compensating financial executor. | Do not implement a final ledger writer or reinterpret internal saga status/declarative compensation as a financial commit. |

### D2 example requiring an actual choice

Eligible invoice base = **199 minor units**, eligible credits = **2**. Aggregate flooring gives `floor(199 × 2 / 100) = 3` minor units; separately flooring each credit gives `2 × floor(199 / 100) = 2`. Both cannot be authoritative for the same application.

If the owner chooses aggregate flooring, the owner must also approve how the 3 minor units are attributed across the two reservations (including deterministic residual assignment). This packet selects neither calculation nor allocation. The adopted percentage and invoice cap are not changed.

For each D1–D4 decision, record:

- Decision ID and approved versioned specification.
- Authorized owner identity, decision date and durable approval reference.
- Exact selected behavior, scope/effective date and concrete examples.
- Explicit development scope permitted by that decision.
- Unresolved conflicts with frozen architecture; if any remain, dependent implementation stays stopped.

## Development stop and release status

**D1 instrument and attribution design are selected for development only** in S08-INSTRUMENT/1; economic/tax details remain unresolved. D2–D4 also remain required for their dependent work. Full server-authenticated identity binding is an implementation gap even after those decisions; no input tuple alone grants authority.

Until the relevant decisions are recorded, restrict work to review, documentation and non-activating checks that do not select an economic behavior. Any frozen-architecture conflict requires resolution before dependent development.

S08-PIC/1 remains Proposed. No Stripe benefit writes, credit consumption, compensating financial execution, production migration, deployment, certification or financial activation. `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain unchanged. Merging this packet grants no additional approval beyond the explicitly recorded development-only timing and instrument/attribution design decisions.
