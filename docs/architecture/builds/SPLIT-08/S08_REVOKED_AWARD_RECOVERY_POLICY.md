# Split 07 / Split 08 — Revoked-award recovery policy (decision proposal)

**Status: PROPOSED for owner decision. DESIGN ONLY. No code, no migration, no executor, no provider call, no activation.** Nothing in this document changes behaviour. It records what the system does today (verified against the code at `main` 4454208), why an approved revocation can leave a credit stranded, and a fail-closed policy for each state the credit can be in. Financial activation remains NO-GO. Every item in "Owner decisions" below needs your answer before any executor is designed or built.

## 1. The problem in one paragraph

A platform administrator can open a dispute on an award, a second administrator can approve a revocation, and the dispute is then resolved `revoked`. That records an **approved plan** (`executed: false`) and the award stays **held**. Nothing executes the plan, and the one operation that could unwind a reserved credit (reservation release) is deliberately unbuilt. So a credit that was already reserved, or whose benefit was already applied at the provider, can sit in `reserved` indefinitely: it cannot be consumed (the hold refuses it), cannot be released (no authority), and cannot be reversed (the reversal path fails closed for a reserved lot).

## 2. What exists today (verified)

| Fact | Where |
|---|---|
| A dispute can be opened only for an award in state `provisional` or `vested`, one open dispute per award; open, evidence, propose, decide and resolve all require an **active platform administrator** and are audit-evented. | `partner-credit-dispute.service.ts` (`open`, `requireAdmin`) |
| A revocation needs **dual control**: one administrator proposes, a **different** one approves (the database also refuses self-approval). Resolving `revoked` records `plan = { type: 'revoke_award', decisionId, units, correctionId, proposedBy, approvedBy, executed: false }`. **Nothing is written to the ledger, lot, account or award.** | `proposeRevocation`, `decideCorrection`, `resolve` |
| The award is **held** while a dispute is `open` **or `revoked`**. The hold is enforced at vest, expiry, reserve, application recording and consumption. | `hasActiveDisputeHold`; call sites in the lifecycle, reservation, application and consumption services |
| The hold is **not** checked by the Split 06 settlement-reversal compensator. A settlement reversal can reach an award whose dispute is open or revoked. | `partner-provisional-reversal.compensator.ts` (no hold call) |
| A resolved dispute row is **immutable** (the `resolve_once` trigger refuses any update once the state is not `open`). So `plan.executed` can never be flipped on the dispute row: an execution needs its own record. | migration 0050, `partner_credit_dispute_resolve_once()` |
| Reservation **release always throws** `SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED` after validating the reservation (it needs provider-verified failure or cancellation, which is not wired). | `partner-credit-reservation.service.ts` (`release`) |
| The pure Split 08 saga already has a **reversal vocabulary**: reversal of a `reserved` intent gives `released (REVERSED_BEFORE_APPLICATION)`; during `applying` it gives `retained (REVERSAL_DURING_APPLICATION)` with the reversal reference queued; after `consumed` it appends a **negative compensation record** (a record only, no provider write). | `invoice-benefit-application.saga.ts` |
| The Split 06 compensator reverses `provisional` and `available` credits (a `reverse` ledger entry, bucket decrement). A credit consumed **through an invoice** originates exactly one **recovery obligation** (D4: `consumed_reversal` ledger entry, `recovery_due` +1, lot and decision `reversed`) that later vesting credits offset FIFO. **Reserved, expired and every other state fail closed** (`PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED` or `..._RECOVERY_POLICY_NOT_IMPLEMENTED`). | the compensator; `applyRecoveryAtVest` in the vest path |

## 3. State matrix: what a revoked-plan award can look like, and the proposed outcome

"Today" is verified current behaviour; "Proposed" is the policy for owner decision. Every proposed action is idempotent, evidence-preserving, and performed only by a future, separately authorized executor.

| # | State at execution time | Today | Proposed |
|---|---|---|---|
| A | Decision `provisional`, lot `provisional` | Held (cannot vest); plan never executes | **Revoke**: same effect as the existing provisional reversal (`reverse` −1, provisional bucket −1, lot and decision `reversed`), keyed to the correction. |
| B | Decision `vested`, lot `available` | Held (cannot reserve or expire) | **Revoke**: same effect as the existing available reversal (`reverse` −1, available bucket −1, lot and decision `reversed`). |
| C | Lot `reserved`, reservation `reserved`, saga `reserved` or none, no provider attempt | Stranded (release throws) | **Blocked, recorded for operator review.** No write. Resolved only when release authority exists (provider-verified no-effect), then treated as B. |
| D | Lot `reserved`, saga `applying` or `retained` (a provider attempt exists, outcome unknown) | Stranded | **Blocked, recorded.** Never release or revoke while a provider effect is unknown; the saga's own reconciliation (`consumed` or `released`) must finish first, then C or E applies. |
| E | Lot `reserved`, saga `consumed` and `confirmed` (the provider effect exists), application/consumption refused by the hold | **Stranded, the dead end.** | See section 4 (the one real decision). Recommended: **settle the fact, then reverse**. |
| F | Lot `consumed` through an invoice, decision `vested` | Held; plan never executes | **Revoke as a consumed-credit reversal**: the existing recovery-obligation mechanism, keyed to the correction (obligation `reversal_ref` = correction id). History (reservation, application, `consume` entry) is never edited. |
| G | Lot `expired` (or consumed by a recovery-offset vest) | Held | **Close as nothing-to-revoke**: record an execution with no balance effect; mark superseded. |
| H | Decision already `reversed` (a Split 06 reversal ran first) | Reversal succeeds regardless of the hold; the plan is stale | **Close as superseded**: record it, no write. The settlement reversal is authoritative. |

## 4. The one real decision: case E

The provider effect is real (the saga reconciled a verified benefit), but the hold stops the application and the consumption from being recorded, so the credit is neither spent nor spendable. Options:

- **E1 — settle the fact, then reverse (recommended).** Add a narrowly scoped, revocation-approved exception to the D4-02 hold rule: for an award with an approved, unexecuted revocation, the executor (and only the executor) may record the application and the consumption (so the books say what already happened at the provider), and then performs the consumed-credit reversal of case F, which creates one recovery obligation. No refund, no provider call. Cost: the platform absorbs the benefit already applied, recovered only as future earned credits offset the obligation. Benefit: the reserved bucket and the audit stay truthful, the unit does not sit stranded, and the history is complete.
- **E2 — keep it stranded, operator reconciliation only.** Leave the credit `reserved` and held, and have an operator reconcile out of band. Simplest and zero new write paths, but it permanently breaks the "reserved bucket = live reservations" invariant, grows with every such case, and relies on manual action.
- **E3 — compensate at the provider (credit note or reversal).** Recovers value in cash terms but is a provider write path, which is not authorized and not built. Not available until that path and its authorization exist.

**Recommendation: E1**, because it uses only machinery that already exists (the writer, the consumer, the recovery obligation) under a dual-controlled approval, and writes nothing to the provider. It does change a ratified rule (D4-02), so it needs your explicit approval.

## 5. Principles (proposed to be binding)

1. **Fail closed.** If any fact is missing or ambiguous (unknown provider outcome, mismatched evidence, tenant mismatch), record a **blocked** result and write nothing.
2. **Evidence is never edited.** No reservation, application, saga, ledger or dispute row is changed after the fact; corrections are new, append-only rows.
3. **No automatic money or provider movement.** No refunds, no provider compensation, no release without provider-verified authority.
4. **Dual control stays, and execution is separately attributed.** Proposal and approval are already two different administrators. The executor must not be the proposer, and its identity is recorded.
5. **Idempotent and race-safe.** One execution per correction; the same lock order as everything else (settlement, decision, lot, account, reservation; the saga row is read), and a replay returns the recorded result.
6. **The Split 06 reversal always wins.** A settlement reversal is authoritative money truth and is never blocked by a dispute hold; the plan is then closed as superseded.
7. **Recovery is offset, not clawback.** A revoked credit that was already consumed becomes a recovery obligation offset by later earned credits (the existing mechanism), unless you decide otherwise (R1).

## 6. Executor sketch (future block, NOT authorized)

For your review of feasibility only; nothing here is built.
- **Input**: a dispute in state `revoked` whose plan is approved and has no execution record.
- **Execution record**: because a resolved dispute cannot be updated, a new append-only table (for example `partner_credit_revocation_executions`: correction id unique, outcome `executed | superseded | blocked`, reason, actor, timestamps, the ledger entry reference) written in the same transaction as the effect. It needs a migration, a write guard in line with the other inert tables, and a `BEFORE TRUNCATE` trigger (`ENABLE ALWAYS`) like every protected table.
- **Effects by case**: A and B reuse the `reverse` entry shape (idempotency key `partner-revocation:v1:<correctionId>`); F and E1 reuse `consumed_reversal` plus the obligation; C, D, G and H write only the execution record.
- **Hold semantics**: the hold would stay until an execution record exists, and a recorded `blocked` result keeps it.
- **Required tests (before any review)**: every state A to H; replay and parallel executors; a Split 06 reversal racing the executor; the executor refused when it is the proposer; the audit and the ledger identity holding after each case; tenant isolation; mutations of each guard.
- **Mandatory independent review** of the exact commit, as for D4.

## 7. Owner decisions needed

| # | Question | Recommended answer |
|---|---|---|
| R1 | Recovery model for a benefit already applied or consumed: offset-only through recovery obligations, or cash clawback? | **Offset-only.** Cash clawback needs the provider write path, which is unauthorized and unbuilt. |
| R2 | Case E: E1 (settle the fact, then reverse), E2 (stay stranded) or E3 (provider compensation)? | **E1**, as an explicit exception to D4-02 limited to awards with an approved revocation. |
| R3 | Cases C and D (reserved, no confirmed effect): block until release authority exists, or define another release authority now? | **Block and record.** Do not release without provider-verified no-effect. |
| R4 | A Split 06 settlement reversal while a dispute is open or revoked: proceed (and supersede the plan) or be blocked by the hold? | **Proceed**; close the plan as superseded. |
| R5 | Who may execute a revocation? | An active platform administrator who is **neither the proposer nor the approver** if you want three-person control, or at minimum not the proposer. |
| R6 | Expired or offset-consumed lot: close as "nothing to revoke"? | **Yes**, with an execution record and no balance effect. |
| R7 | Should an open or revoked-unexecuted dispute have an age limit with alerting (never automatic resolution)? | **Yes**: alert, never auto-resolve. |
| R8 | Is the new execution record table acceptable as the only schema change? | **Yes**; no change to the frozen dispute table. |

## 8. What this document does not authorize

No executor, no migration, no ledger or lot writes, no change to the D4-02 hold, no release path, no provider call, no Stripe or production access, no activation. Approving R1 to R8 only authorizes a **design and development-only build** of an inert executor, under the same controls as D4 (disposable databases, mutation tests, independent review, no auto-merge). Financial activation, the provider write path, the release authority, the D1 and D3 decisions, Stripe test-mode evidence and the 17 PIC/1 scenarios are all unchanged and still open.
