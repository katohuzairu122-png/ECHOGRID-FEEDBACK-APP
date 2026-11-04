# Split 07 / Split 08 — Revoked-award recovery policy (decision proposal)

**Status: PROPOSED for owner decision. DESIGN ONLY. No code, no migration, no executor, no provider call, no activation.** Nothing in this document changes behaviour. It records what the system does today (verified against the code at `main` 4454208, then corrected after an independent fact-check), why an approved revocation can leave a credit stranded, and a fail-closed policy for each state the credit can be in. Financial activation remains NO-GO. Every item in "Owner decisions" needs your answer before any executor is designed or built.

## 1. The problem

A platform administrator can open a dispute on an award, a second administrator can approve a revocation, and the dispute is then resolved `revoked`. That records an **approved plan** (`executed: false`) and the award stays **held**. Nothing executes the plan. A credit that was already reserved, or whose benefit was already applied at the provider, can therefore sit in `reserved` indefinitely: it cannot be consumed (the hold refuses it), cannot be released (no authority), and cannot be reversed (the reversal path fails closed for a reserved lot).

**A larger consequence found in review:** because the Split 06 settlement reversal calls the Split 07 compensator inside its own transaction ("any failure rolls back BOTH"), a **reserved, expired or recovery-offset-consumed credit makes the settlement reversal itself fail and roll back**, with or without a dispute. So today a settlement whose credit is in one of those states cannot be reversed at all. That is a prerequisite problem for any revocation policy (see R4 and R10).

## 2. What exists today (verified)

| Fact | Where |
|---|---|
| A dispute can be opened only for an award in decision state `provisional` or `vested`; only one dispute may be `open` per award (a `revoked` or `released` one does not block a new one). The decision stays `vested` while its lot is available, reserved, consumed or expired, which is why a dispute can still be opened on all of those. | `partner-credit-dispute.service.ts` (`open`); migration 0050 partial unique index |
| Open, evidence and resolve each require an **active platform administrator** and write an append-only dispute event. **Propose and decide write no event** (the event kinds are `opened`, `evidence_added`, `resolved_upheld`, `resolved_revoked`); proposer and decider are recorded only on the correction row, and a rejected correction leaves no event. | dispute service; 0050 event-kind CHECK |
| A revocation needs **dual control**: one administrator proposes, a **different** one approves (the database also refuses self-approval). Resolving `revoked` records `plan = { type: 'revoke_award', decisionId, units, correctionId, proposedBy, approvedBy, executed: false }`. **Nothing is written to the ledger, lot, account or award.** Corrections are unique per (dispute, kind), so one award can carry several approved plans if several disputes were opened in turn. | `proposeRevocation`, `decideCorrection`, `resolve`; 0050 |
| The award is **held** while a dispute is `open` **or `revoked`**, and the hold never lifts for a `revoked` one. It is enforced at vest, expiry, reserve, application recording and consumption. A later `upheld` dispute cannot lift the hold of an earlier `revoked` one, and no path withdraws a mistaken revoked plan. | `hasActiveDisputeHold`; call sites in the lifecycle, reservation, application and consumption services |
| The hold is **not** checked by the Split 06 settlement-reversal compensator, **and not by the Split 08 saga** (`begin_apply` and provider observations). A held, reserved credit can still reach the provider and move to `applying` or `consumed`. | the compensator; `benefit-application.saga.service.ts` (no hold call) |
| A resolved dispute row is **immutable** (the `resolve_once` trigger refuses any update once the state is not `open`), so `plan.executed` can never be flipped on it: an execution needs its own record. | migration 0050 |
| Reservation **release always throws** `SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED` for a reserved reservation. Nothing ever expires a reservation row after `expires_at`, and the saga service executes only the `append_compensation` effects, not the `release` effect, so even a saga that reaches `released` leaves the reservation and lot `reserved`. This happens without any dispute. | `release`; saga service effect loop |
| The pure saga's reversal vocabulary: reserved gives `released (REVERSED_BEFORE_APPLICATION)`; applying or retained gives `retained (REVERSAL_DURING_APPLICATION)` with the reversal reference queued; consumed appends a **negative compensation record** (a record only, no provider write). | `invoice-benefit-application.saga.ts` |
| The Split 06 compensator reverses `provisional` and `available` credits (`reverse` entry and bucket decrement). A credit consumed **through an invoice** originates one **recovery obligation** (`consumed_reversal` entry, `recovery_due` +1, lot and decision `reversed`), offset FIFO by later vesting credits. **Every other state throws**, which rolls back the whole settlement reversal. | the compensator; `applyRecoveryAtVest` |
| An outstanding recovery obligation (`recovery_due > 0`) makes **reserve refuse every credit of that account** (`PARTNER_RESERVE_ACCOUNT_NOT_ELIGIBLE`) until offsets clear it. | `partner-credit-reservation.service.ts` |

## 3. State matrix: what a revoked-plan award can look like, and the proposed outcome

"Today" is verified current behaviour; "Proposed" is the policy for owner decision. Every proposed action is idempotent, evidence-preserving, and performed only by a future, separately authorized executor. The executor's world is a **point-in-time read**: the saga can still move (it ignores the hold), so every result is re-validated under lock and may be `blocked`, retried later.

| # | State at execution time | Today | Proposed |
|---|---|---|---|
| A | Decision `provisional`, lot `provisional` | Held (cannot vest); plan never executes | **Revoke**: same effect as the existing provisional reversal (`reverse` −1, provisional bucket −1, lot and decision `reversed`). |
| B | Decision `vested`, lot `available` | Held (cannot reserve or expire) | **Revoke**: same effect as the existing available reversal (`reverse` −1, available bucket −1, lot and decision `reversed`). |
| C1 | Lot `reserved`, reservation `reserved`, saga `reserved` or none, no provider attempt | Stranded (release throws) | **Blocked, recorded, retryable.** No write. Becomes B only when release authority exists. |
| C2 | Lot `reserved` but the **saga is `released`** (provider-confirmed no effect, or reversed or unused) or the reservation has passed `expires_at` with no effect | Stranded (the release effect is never executed) | **Blocked, recorded, retryable**, but this is the only case that already has provider-verified no-effect evidence. R3 asks whether that evidence counts as release authority; if yes, release then B. |
| D | Lot `reserved`, saga `applying` or `retained` (a provider attempt exists, outcome unknown) | Stranded | **Blocked, recorded, retryable.** Never release or revoke while a provider effect is unknown; the saga's reconciliation must finish first, then C2 or E applies. |
| E | Lot `reserved`, saga `consumed` and `confirmed` (the provider effect exists), recording refused by the hold | **Stranded, the dead end.** | See section 4. Recommended: **settle the fact, then reverse**, subject to the E1 preconditions. |
| E-late | As E, but the provider effect was confirmed **after the reservation deadline** | Held for review (D4-03) | **Blocked, recorded for operator review.** The writer, the consumer and the database trigger all refuse an effect later than the deadline, so E1 cannot apply; this needs its own owner handling. |
| F | Lot `consumed` through an invoice, decision `vested` | Held; plan never executes | **Revoke as a consumed-credit reversal**: the existing recovery-obligation mechanism, keyed to the correction (obligation `reversal_ref` = correction id, which is a uuid). History is never edited. |
| G1 | Lot `expired` | Held; reversal path throws | **Close as nothing-to-revoke**: record the execution, no balance effect; the decision is moved to `reversed` so the hold has no further meaning (the audit mapping of an expired lot under a reversed decision is to be confirmed in design). Expiry cannot slip in between approval and execution, because the hold blocks it. |
| G2 | Lot `consumed` by a **recovery-offset vest** (no reservation) | Held; reversal path throws | **Needs its own decision (R6)**: the unit already paid down a recovery obligation, so revoking it arguably should restore `recovery_due`. Blocked until you decide. |
| H | Decision already `reversed` (a Split 06 reversal ran first) | Possible only for A, B and F, where the reversal succeeds regardless of the hold; the dispute stays open or revoked and the hold stays on a reversed decision | **Close as superseded**: a recorded execution with no write. |
| I | **The plan was executed, then a Split 06 reversal arrives** | The compensator takes its `already_reversed` branch, which requires a ledger row keyed `partner-reversal:v1:<settlementRef>`; an executor that writes a different key makes that branch throw `PARTNER_REVERSAL_MISSING_COMPENSATION`, so the settlement could never be reversed | The executor must write its ledger entries under the settlement-reversal key shape, or the compensator must be amended to recognise an executed revocation. Needs a dedicated test; see R10. |

## 4. The one real decision: case E

The provider effect is real (the saga reconciled a verified benefit), but the hold stops the application and the consumption being recorded, so the credit is neither spent nor spendable. Options:

- **E1: settle the fact, then reverse (recommended, with caveats below).** Add a narrowly scoped, revocation-approved exception to the D4-02 hold rule: for an award with an approved, unexecuted revocation, the executor (and only the executor) may record the application and the consumption so the books say what already happened at the provider, and then perform the consumed-credit reversal of case F, which creates one recovery obligation. No refund, no provider call. Cost: the platform absorbs the benefit already applied, recovered only as future earned credits offset the obligation.
- **E2: keep it stranded, operator reconciliation only.** Zero new write paths, but it permanently breaks the "reserved bucket equals live reservations" invariant, grows with every such case, and relies on manual action.
- **E3: compensate at the provider (credit note or reversal).** Recovers cash value but is a provider write path, which is not authorized and not built.

**E1 preconditions and side effects (what review found, and what the recommendation must carry):**
1. It works only if every existing precondition of the writer and consumer holds: settlement fulfilled with no `settlement_reversed` event, decision `vested`, a frozen allocation item matching the invoice, currency and amount, **exactly one `active` business subscription**, and the effect confirmed **no later than the reservation deadline**. A lapsed subscription or a late effect makes E1 impossible and falls to a blocked record (E-late covers the late effect).
2. **The recovery obligation blocks the business.** While it is outstanding the account cannot reserve any credit. That is a real operational effect on the business, and it needs your explicit acceptance.
3. E1 is "mostly existing machinery", not "only": the consumed-credit reversal is a private routine tied to a Split 06 reversal event and a fixed key, so it needs a refactor before an executor can reuse it, and the executor cannot simply call `record()` (it locks the reservation then the intent with no settlement lock) without adopting one consistent lock order.
4. The database triggers do not check the hold (it is application-level only), so the exception is technically possible, but it is a change to a ratified rule (D4-02) and needs your approval.

## 5. Principles (proposed to be binding)

1. **Fail closed.** If any fact is missing, ambiguous or may have changed (unknown provider outcome, mismatched evidence, tenant mismatch), record a **blocked** attempt and write nothing.
2. **Evidence is never edited.** No reservation, application, saga, ledger or dispute row is changed after the fact; corrections are new, append-only rows.
3. **No automatic money or provider movement.** No refunds, no provider compensation, no release without provider-verified authority.
4. **Dual control stays, and execution is separately attributed.** Proposal and approval are already two administrators. The executor's identity is recorded; it must not be the proposer.
5. **Idempotent and race-safe.** One final execution per **decision**; the established lock order (settlement, decision, lot, account, reservation; the saga intent and the dispute rows locked after, `FOR UPDATE`, in one fixed order), and a replay returns the recorded result.
6. **A Split 06 reversal is authoritative and is never blocked by a dispute hold itself.** Today it can still fail for reserved, expired or offset-consumed credits (section 1); closing that is a prerequisite (R4, R10), not something this policy can assume.
7. **Recovery is offset, not clawback**, unless you decide otherwise (R1).

## 6. Executor sketch (future block, NOT authorized)

For feasibility review only; nothing here is built.
- **Input**: a dispute in state `revoked` with an approved plan and no final execution for its decision.
- **Records**: because a resolved dispute cannot be updated, execution needs its own append-only storage, and it must separate **attempts** (many, for example `blocked` with a reason, retried later) from the **final execution** (one per decision, enforced by a partial unique index on the decision for the outcomes `executed` and `superseded`). A single row per correction cannot represent "blocked, retry later", and a key per correction would allow several final executions of one award across several disputes.
- **Hold**: no change to `hasActiveDisputeHold` is needed if every final outcome moves the decision to `reversed` (executed, superseded, and G1); `blocked` leaves the award held, which is intended. The cost is that the executor must transition the decision for every final outcome.
- **Effects by case**: A and B reuse the `reverse` entry shape; F and E1 reuse `consumed_reversal` plus the obligation; C1, C2, D, E-late and G2 write only an attempt record; G1 and H write the final record. Ledger keys follow the settlement-reversal shape (case I) or the compensator is amended.
- **Withdrawing a mistaken revoked plan** has no path today; R9 asks for a dual-controlled one, or a rule that a new dispute cannot be opened on an award that carries an unexecuted revoked plan.
- **Required tests before any review**: every state A to I; replay and parallel executors; a settlement reversal racing the executor; the saga moving between the executor's read and its write; the executor refused when it is the proposer; the audit and the ledger identity holding after each case; the account's reserve gate after E1; tenant isolation; mutations of each guard.
- **Mandatory independent review** of the exact commit, as for D4.

## 7. Owner decisions needed

| # | Question | Recommended answer |
|---|---|---|
| R1 | Recovery model for a benefit already applied or consumed: offset-only through recovery obligations, or cash clawback? | **Offset-only.** Cash clawback needs the provider write path, which is unauthorized and unbuilt. |
| R2 | Case E: E1, E2 or E3, and do you accept that E1 blocks the business's reserves until the obligation is offset? | **E1**, as an exception to D4-02 limited to awards with an approved revocation, with that side effect accepted explicitly. |
| R3 | Case C2: does the provider-confirmed no-effect evidence (a `released` saga, or an expired unused reservation) count as release authority? For C1 and D: block until authority exists? | **Yes for C2** (it is the evidence CE-1 asks for), **block** for C1 and D. |
| R4 | A Split 06 settlement reversal while a dispute is open or revoked: it is not blocked by the hold, but it fails today for reserved, expired and offset-consumed credits. Proceed and supersede the plan where it can, and treat the failure as a prerequisite? | **Proceed and supersede**; and treat extending the compensator to those states as a separate prerequisite block (R10). |
| R5 | Who may execute a revocation? | An active platform administrator who is **neither the proposer nor the approver** for three-person control, or at minimum not the proposer. |
| R6 | G1 (expired): close as nothing-to-revoke. G2 (consumed by a recovery-offset vest): restore `recovery_due`, or leave blocked? | **G1 yes.** **G2: your decision**; it affects what the business owes. |
| R7 | Should an open, or revoked-and-unexecuted, dispute have an age limit with alerting (never automatic resolution)? | **Yes**: alert, never auto-resolve. |
| R8 | Is new execution storage (attempts plus one final execution per decision) acceptable as the only schema change? | **Yes**, plus a possible compensator refactor under R10; no change to the frozen dispute table and none to the hold function. |
| R9 | A mistaken revoked plan has no withdrawal path and a later `upheld` dispute cannot lift the hold. Add a dual-controlled withdrawal, or forbid a new dispute on an award with an unexecuted revoked plan? | **Dual-controlled withdrawal**, audited by a dispute event. |
| R10 | Prerequisite: extend the Split 06 compensator (or the executor's key shape) so a settlement reversal succeeds, or is safely recognised as already revoked, for reserved, expired and offset-consumed credits and for case I? | **Yes**, as its own block before or with the executor. |

## 8. What this document does not authorize

No executor, migration, ledger or lot writes, change to the D4-02 hold, change to the compensator, release path, provider call, Stripe or production access, or activation. Approving R1 to R10 would only authorize a **design and development-only build** of an inert executor (and, under R10, a compensator extension), under the same controls as D4: disposable databases, mutation tests, independent review, no auto-merge. Financial activation, the provider write path, the release authority, the D1 and D3 decisions, Stripe test-mode evidence and the 17 PIC/1 scenarios are all unchanged and still open.
