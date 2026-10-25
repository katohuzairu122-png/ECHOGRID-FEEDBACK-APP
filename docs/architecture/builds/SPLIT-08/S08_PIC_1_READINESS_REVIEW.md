# S08-PIC/1 readiness review — 2026-10-25

**Disposition: documentation only; NOT certified, NOT activation authorization.**

The [proposed S08-PIC/1 contract](PROVIDER_INTEGRATION_CONTRACT_S08_PIC_1.md) reproduces the owner's supplied requirements, with Markdown headings only. This companion is a non-normative source review and acceptance plan. It does not revise the contract or any frozen architecture.

## Reviewed baseline

- Default branch: `main`, commit `f2c0a5429c1903911a3cbc0c5a6d75ea82f6bf83`.
- PR #174 integrated the work from #169–#171: read-only provider reconciliation (0049), disputed-award holds and dual control (0050), and HETA persisted foundations (0051). These are now on the reviewed baseline.
- The provider adapter and reconciler below were inspected on integrated `main`. Integration closes the earlier branch gap; it does not close the identity, instrument, accounting or activation gates.
- Full integration-PR CI passed on `4705c4eafa2142c0c19ac730bffad772f700f30f`: [run 40189320642](https://github.com/katohuzairu122-png/ECHOGRID-FEEDBACK-APP/actions/runs/40189320642). It reported 1,220 API unit tests, 266 web unit tests, and 447 integration tests passed / 21 skipped, plus the separate 21 Partner Award checks. These are component results, not S08-PIC/1 certification.
- See the [component coverage and owner decision packet](S08_PIC_1_COMPONENT_COVERAGE_AND_OWNER_DECISIONS.md) for the remaining evidence gaps and explicit decision fields.
- Existing authority: [owner development baseline](../OWNER_DECISIONS_2026-10-23.md) and [provider reconciliation freeze gate](INVOICE_BENEFIT_ECONOMICS_PROVIDER_RECONCILIATION_FREEZE_GATE.md). Testing defaults in the owner baseline remain testing defaults.

## Source findings and blockers

| Contract area | Source evidence | Readiness consequence |
| --- | --- | --- |
| A: authenticated complete identity | `apps/api/src/billing/benefit-application.saga.service.ts` derives business identity from a reservation and persists invoice, amount, currency and policy. Its intent view does not bind account, operating mode, customer or subscription. The integrated reconciler accepts that provider scope from its caller. | A stored intent alone is not authorization. An authenticated server-side binding for the entire tuple, including intent, reservation, policy and stable operation key, remains required. No new caller is wired. |
| B: provider write | The saga stores `benefit-apply:v1:<reservationId>` in its provider-attempt record. The reviewed adapter is read-only. | A stable key is an existing foundation, not proof of authorized provider mutation. The Stripe adjustment instrument remains an owner decision; no write adapter may be selected or activated from this contract. |
| C: independent reconciliation | Integrated files `provider-effect.adapter.ts` and `benefit-reconciliation.service.ts` verify account/mode and invoice/customer/subscription/currency, read all line pages, retain unverifiable outcomes, and require at least two separated complete absence observations. Exact amount is classified by the saga. | Preserve this read-only path as authoritative. Its candidate negative-line metadata extractor is explicitly not an approved Stripe instrument or proof of authenticated attribution. Establishing the full identity trust boundary and the approved instrument-specific evidence remains outstanding. |
| C: absence boundary | The low-level saga accepts an `effect_absent` event after the attempt start; the repeated-read rule lives in the integrated reconciler, not the saga primitive. | Future callers must not bypass independent reconciliation by submitting an untrusted observation directly. A successful provider write response, caller assertion or metadata value cannot certify an effect. |
| D: final consumption | The service explicitly moves no account, lot, ledger or reservation. Its internal `consumed` state means provider-effect reconciliation and produces declarative effects only. | Never treat this state or an emitted `consume` effect as committed Partner Credit consumption. A separately authorized transaction must enforce all six section D conditions and the frozen lock order/invariants. |
| D/E: reversal and compensation | The pure state machine can reconcile an effect while retaining reversal references as declarative compensation effects; persisted compensation records are not financial execution. | A confirmed provider effect with an unresolved reversal/compensation cannot pass the final consumption gate. Do not execute compensation or change frozen saga semantics to work around this distinction. Stop for architecture review if the intended consumer conflicts. |
| E: recovery | Inert persistence records attempts, observations and transitions; the branch reconciler leaves crashed attempts visible and classifies rate limits/errors. | Provider-write timeout/crash recovery and economic deduplication are not proven by read-only reconciliation tests. Loss of an HTTP response must never justify a fresh economic action or replacement identity. |
| F/G: certification | This change performs source review only. | All 17 end-to-end scenarios below remain uncertified. Existing unit/integration tests are component evidence only; no activation, migration or deployment is authorized. |

## Decisions and authorization still required

Implementation stops at these boundaries; this review does not supply defaults:

1. Exact Stripe adjustment instrument and its reservation-attribution evidence.
2. Approved per-reservation amount allocation and rounding when multiple credits target one invoice. PR #168 already flags aggregate-floor versus per-unit-floor differences.
3. Invoice settlement eligibility/timing and evidence for the chosen instrument. Existing development-only eligibility assumptions are not production sign-off.
4. Final consumption accounting vocabulary and transactional design consistent with frozen ledger constraints, Split 07 authority, and all unresolved-obligation checks. Do not weaken constraints or reinterpret saga status as ledger authority.
5. Separate authority for any compensating financial execution, certification, and subsequent activation. This proposed contract grants none.

## Acceptance evidence plan

**Status for every row: NOT RUN / NOT CERTIFIED in this review.** Assertions below describe required evidence, not observed test results.

For every scenario, capture before/after reservation, lot, account, immutable ledger and terminal application state on an isolated disposable fixture. Assert the existing accounting/conservation invariants using the frozen model. Provider-only and reconciliation-only work must leave credit balances unchanged. An eventual separately authorized consumption fixture must commit each permitted movement exactly once; any failed gate must commit no financial movement. Preserve immutable dispute/reversal evidence. A mock provider can exercise failure paths but does not certify a real Stripe instrument.

| Required scenario | Required evidence before activation |
| --- | --- |
| Duplicate submission | Same persisted intent/operation identity; no second provider economic effect or consumption. Conflicting input is refused. |
| Concurrent application attempts | Competing workers cannot authorize two economic applications for one reservation; credit balances stay conserved. |
| Timeout after successful provider mutation | Simulate a committed provider action with a lost response. Recover the original identity through independent reconciliation without applying a second benefit or consuming early. |
| Provider rate limitation | Durable classified retry and provider delay handling preserve identity and the pending obligation; no credit movement. |
| Wrong account or mode | Independently verified scope mismatch refuses mutation/confirmation and retains any unknown obligation. |
| Cross-business substitution | Substituting business, reservation, intent, customer or subscription cannot cross the authenticated tenant boundary or touch another business's balances. |
| Incorrect invoice or currency | Fail immediately before mutation and during reconciliation; no invoice substitution, currency conversion or ledger movement. |
| Wrong benefit amount | Mutation cannot exceed or substitute the approved amount; independently observed non-exact amount remains disputed. |
| Unattributed benefit | A response or invoice adjustment without authenticated exact reservation attribution cannot establish a reconciled effect or consumption. |
| Partial pagination | A truncated, capped or unpageable read cannot establish complete evidence or absence; obligation remains pending. |
| Unknown provider outcome | Timeout, unavailable provider or unverifiable evidence retains the obligation; no fabricated success or one-read absence. |
| Duplicate provider effect | Multiple effects for one reservation, or reuse of one effect for another reservation, cannot authorize consumption; dispute remains visible. |
| Reservation expiry | Cover expiry before application and while the outcome is unknown. No unauthorized spend or unsafe release; preserve evidence of any provider obligation. Stop for an owner decision if the frozen rules do not determine the outcome. |
| Reversal during application | Pending provider outcome stays recoverable; unresolved reversal/compensation blocks final consumption and no financial compensation runs without separate authority. |
| Multiple credits targeting one invoice | Distinct reservation identities cannot alias effects or exceed the approved invoice benefit/cap; verify the owner-approved aggregate allocation and exact amount for each. |
| Recovery after process crash | Crash before/after provider mutation and before/after durable recording. A new process recovers the same operation and obligation without duplicate economic action. |
| Concurrent final settlement | Competing finalizers commit at most one terminal application/consumption under the frozen transaction and lock order; settlement, dispute and reversal races fail closed. |

## Release disposition

No Stripe benefit writes, credit consumption, financial activation, production migration or deployment. No route, queue, cron, provider credential, authorization flag, guard or evidence requirement changes. `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain unchanged.

The development branch integration is complete; owner decisions and end-to-end activation evidence remain outstanding. A green documentation PR or existing component CI is not S08-PIC/1 certification.

Validation for this change: source inspection, contract text preservation, all 17 scenario names present, and documentation-only diff. No runtime, database or provider tests were executed for this documentation review.
