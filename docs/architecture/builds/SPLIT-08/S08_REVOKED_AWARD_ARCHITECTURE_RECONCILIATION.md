# Split 07 / Split 08 — Revoked-award recovery: owner decision register, architecture reconciliation and acceptance matrix

**Status: DESIGN AND DEVELOPMENT PLANNING ONLY. Nothing here is implemented.** The owner's decisions R1 to R10 (section 1) authorize architecture design and development planning. They do **not** authorize implementation. No merge, deployment, production access, financial activation, provider write, or automatic progression between blocks. Financial activation: **NO-GO**. Implementation of the first block (R10) awaits explicit authorization.

Source proposal: [S08_REVOKED_AWARD_RECOVERY_POLICY.md](S08_REVOKED_AWARD_RECOVERY_POLICY.md) (states A to I, case E, R1 to R10). This document reconciles each decision with the code as it is on `main` and turns it into acceptance criteria. Facts below were read from the code at `main` cc80216; items I could not settle from the code are marked **OPEN** and need an owner answer (section 4).

## 1. Owner decision register (as recorded)

| # | Decision |
|---|---|
| R1 | ACCEPT. Offset-only recovery; no cash clawback. |
| R2 | **E1.** Reserve-block side effect accepted. Record the confirmed provider effect under the narrow exception, reverse the consumed credit, create exactly one recovery obligation. Require every stated settlement, subscription and deadline condition; otherwise block for reconciliation. |
| R3 | ACCEPT. Verified no-effect evidence counts for C2. Block C1 and D until sufficient release authority exists. |
| R4 | ACCEPT. A settlement reversal may supersede the revocation plan where valid, subject to the R10 prerequisite. |
| R5 | ACCEPT. Three-person control: proposer, approver and executor must be distinct, active, authorized administrators. |
| R6/G1 | YES. An expired, unconsumed lot may close with no balance adjustment, provided no other financial effect exists. |
| R6/G2 | **RESTORE `recovery_due`.** Where a revoked credit reduced a recovery obligation through an offset, reinstate the exact offset amount. Immutable ledger evidence, exact-value reconciliation, idempotency; never a duplicate obligation, never a silent edit of history; block if restoration cannot be proven. |
| R7 | YES, 30 days. Alert after 30 days for unresolved disputes or revoked plans awaiting execution; keep escalating at defined intervals; no automatic resolution, expiry or financial execution. |
| R8 | ACCEPT. Append-only attempts and one immutable final execution record per decision. Preserve the frozen dispute table and the hold function. |
| R9 | ACCEPT. Dual-controlled withdrawal of an erroneous, unexecuted revocation plan with immutable audit evidence. Withdrawal must not reverse an already confirmed provider effect or an executed financial recovery. |
| R10 | ACCEPT as a **separate prerequisite block**: a compensator extension covering reserved, expired, offset-consumed and previously executed revocation cases (case I), with exactly-once financial consequences, replay safety, concurrency controls and correct ledger identity. |

**Proposed sequence (each block needs its own explicit authorization):** (1) R10 compensator prerequisite; (2) revoked-award recovery executor and append-only execution storage; (3) independent PostgreSQL, ledger and mutation verification; (4) owner review of each isolated draft PR.

## 2. Reconciliation of the decisions with the code

### 2.1 Facts that make the decisions workable
- **G2 is provable.** Each recovery offset is an immutable ledger entry (`recovery_offset`, negative units) carrying the vesting credit's `decision_id`, with metadata `{ obligationId, reversalRef, offsetUnits }` and the per-obligation key `partner-recovery-offset:v1:<settlementRef>:<obligationId>` (`applyRecoveryAtVest`). The offset per vesting credit is `min(outstanding, 1)`, so at most one unit. The exact amount and the exact obligation therefore come from existing evidence. The obligation CHECK `units_outstanding <= units_due` makes an over-restore impossible, and `applyRecoveryAtVest` already asserts that the account's `recovery_due` equals the sum of outstanding units, which gives an exact-value reconciliation check.
- **Lock order** settlement, decision, lot, account, reservation is already shared by reserve, release, consume, vest, expire and the compensator; the saga row and the dispute rows are read after, in one fixed order.
- **Database triggers do not check the dispute hold** (it is application-level), so the R2 exception is technically possible without weakening any database guard. Migrations 0053, 0056 and 0057 stay satisfied if the executor orders its writes evidence-first (consumed reservation before lot consumed; `consumed_reversal` entry before lot reversed; terminal time not earlier than the application time).
- **A single canonical idempotency key per decision** closes the exactly-once and case-I problems by construction: the ledger's `idempotency_key` is unique, so if the executor and a Split 06 reversal both write their reversal-class entry under `partner-reversal:v1:<settlementRef>`, only one can ever commit, and the compensator's existing `already_reversed` branch (which looks that key up) recognises an executed revocation.

### 2.2 Per-decision reconciliation

| # | What it requires of the architecture | Verified code facts | Conflict or gap |
|---|---|---|---|
| R1 | Recovery only as obligations offset later; never a provider call. | The consumed-credit reversal already creates one obligation; offsets are FIFO at vest. | None. |
| R2 | E1 exception to the D4-02 hold, executor-only, with every writer precondition. | The application writer needs: fulfilled settlement, no `settlement_reversed` event, decision `vested`, matching frozen allocation item, exactly one `active` subscription, effect not after the reservation deadline. The consumer needs the same plus no hold. Reserve refuses any account with `recovery_due > 0`. | The `settlement_reversed` precondition interacts with R10 (see O2). The executor cannot call the writer as is (different lock order, no settlement lock) and the consumed-credit reversal is private and tied to a Split 06 event; both need a refactor. |
| R3 | C2 recognised as release authority; C1 and D blocked. | The saga's `release` effect is never executed, and release throws for every reserved reservation. | C2 needs the executor to perform the release itself under its own evidence check (the generic release stays unbuilt); define exactly which evidence qualifies (a `released` saga with provider-confirmed no effect, or an expired unused reservation with no attempt). |
| R4 | Settlement reversal supersedes the plan where valid. | The compensator does not read disputes or plans. | The supersede **record** belongs to the executor (it sees the decision `reversed` and writes a final `superseded`); the compensator must not write it (storage is a later block). Acceptable if stated. |
| R5 | Three distinct active administrators. | Proposer and approver distinctness is enforced by the service and by a database constraint; `requireAdmin` means active platform administrator. | The executor's distinctness is not enforced anywhere today: it needs a database check on the final execution row against the correction's proposer and approver, not only a service check. Operationally at least three active administrators must exist. |
| R6/G1 | Close an expired lot with no balance change. | The compensator throws for expired lots; ledger entries cannot be zero (`units <> 0`). | See O4: a zero-effect close has no ledger row, which the compensator's `already_reversed` branch requires. |
| R6/G2 | Restore the exact offset into the obligation and `recovery_due`. | Provable as in 2.1. | Needs a new informational ledger entry type (restoration evidence), an extension of the 0057 lot rule (it requires a `consumed_reversal` entry for any consumed to reversed move) and of the projection audit (its `CONSUMED_REVERSAL_EVIDENCE` check assumes a consume entry and a consumed reservation). See O4. |
| R7 | 30-day alert, repeated escalation, no automatic action. | No alerting or notification mechanism exists in the repository for Split 07/08. | The escalation intervals and the delivery channel are unspecified (O5). |
| R8 | Append-only attempts, one final execution per decision; do not touch the dispute table or the hold function. | The dispute row is immutable after resolution; the hold function counts `open` and `revoked` forever. | **R8 and R9 conflict** (O1). |
| R9 | Dual-controlled withdrawal with immutable evidence. | The hold function would keep holding a withdrawn plan; the dispute event kinds are a closed set. | O1. Audit evidence should live in the new storage, because adding an event kind would alter a CHECK on an append-only table. |
| R10 | Make a settlement reversal succeed for reserved, expired, offset-consumed and executed-revocation credits. | The compensator throws for the first three and fails the whole reversal transaction. | For **reserved** credits the reversal cannot unwind anything while release is unbuilt, which conflicts with R3 (O2). |

## 3. Cross-cutting architecture

1. **One shared unwind routine** used by both the compensator (inside the Split 06 transaction) and the executor (its own transaction), with the case table below as its only logic. Two copies would diverge.
2. **Canonical idempotency**: reversal-class ledger entries use `partner-reversal:v1:<settlementRef>`; the metadata records the source (`settlement_reversal` or `revocation` with the correction id). For consumed-credit paths the obligation's `reversal_ref` is the reversal event id or the correction id (both uuids, unique).
3. **Ledger vocabulary (migration, Block 1):** an informational entry type for "reversed with no balance effect" (the ledger forbids zero units, so it needs a non-zero informational unit like `consumed_reversal`) and one for "recovery restored" (G2). Both are excluded from the net identity, like `consumed_reversal`, and need CHECKs, one-per-decision indexes and audit checks.
4. **Evidence-first write order** for every case, so migrations 0053, 0056 and 0057 stay satisfied; the lot rule of 0057 is extended to accept the new evidence types.
5. **Execution storage (Block 2):** append-only **attempts** (many; `blocked` with reason, retried later) and one immutable **final execution** per decision (partial unique index on the decision for `executed` and `superseded`), each recording actor identities; a database check that the executor differs from the correction's proposer and approver; every final outcome moves the decision to `reversed`. New tables get a write guard and a `BEFORE TRUNCATE` trigger that is `ENABLE ALWAYS`, like every protected table.
6. **Alerting (R7):** a read-only detector that lists disputes or revoked plans older than a threshold, bucketed by escalation interval; it writes nothing and resolves nothing.

### Case table (state at execution, outcome, owner decision applied)

| State | Outcome | Decision |
|---|---|---|
| A provisional | `reverse` −1, provisional bucket −1, lot and decision `reversed` | existing mechanics |
| B available | `reverse` −1, available bucket −1, lot and decision `reversed` | existing mechanics |
| C1 reserved, no attempt | blocked attempt, retry | R3 |
| C2 reserved, saga `released` or reservation expired unused | evidence-checked release, then B | R3 |
| D reserved, attempt outcome unknown | blocked attempt, retry | R3 |
| E reserved, effect confirmed | settle the fact, then F, subject to every stated condition; otherwise blocked | R2 |
| E-late effect after deadline | blocked for reconciliation | R2 (conditions) |
| F consumed through an invoice | `consumed_reversal`, one obligation, `recovery_due` +1 | R1 |
| G1 expired | close, no balance change, only if no other financial effect | R6 |
| G2 consumed by an offset vest | restore the exact offset into the obligation and `recovery_due`, with evidence; block if unprovable | R6 |
| H decision already reversed | final `superseded`, no write | R4 |
| I executed, then settlement reversal | compensator recognises the canonical key and returns already reversed | R10 |

## 4. Conflicts and open questions that need an owner answer before development

| # | Issue | Why it matters | Recommendation |
|---|---|---|---|
| O1 | **R8 versus R9.** R8 says preserve the hold function; R9 says a withdrawn plan must be possible. The hold function counts a `revoked` dispute forever and the dispute row cannot change, so a withdrawal cannot lift the hold without touching the function. | R9 is unachievable as stated. | Allow one narrow amendment: a `revoked` dispute with a recorded, dual-controlled withdrawal no longer holds. It changes the function once, uniformly for its five call sites, and nothing else. Alternatively drop R9 for a rule that forbids a new dispute on an award with an unexecuted plan (it would not lift an erroneous hold). |
| O2 | **R10 versus R3 and R2 for reserved credits.** A settlement reversal on a reserved credit cannot unwind the reservation while release is unbuilt, so "make the reversal succeed" needs a **deferral record** in Block 1 (append-only, keyed by settlement, resolved later by the executor), and the compensator would return a new "deferred" result. Also, once a settlement has a `settlement_reversed` event, the writer and consumer refuse, so the R2 precondition "not reversed" can never hold for that award. | Without a decision, either reserved-credit reversals stay blocked (R10 not met) or E1's own conditions contradict the deferral. | Add the deferral record to Block 1 and define that an executor-run E1 for a deferred-reversal award takes the reversal as the approved cause (the plan and the reversal agree), by an explicit executor-only rule. Needs your approval. |
| O3 | **Block boundary.** The deferral record in O2 and the ledger vocabulary in 2.2 are new storage in Block 1, though you placed execution storage in Block 2. | Block 1 is larger than "a compensator extension". | Accept a Block 1 containing the compensator extension, the ledger vocabulary migration, and the deferral record. |
| O4 | **Ledger and 0057 evidence for G1, G2 and R10 zero-effect cases.** A zero-effect close needs a non-zero informational entry; G2 restoration needs its own evidence type, and 0057 plus the audit currently assume `consumed_reversal` evidence. | The compensator's `already_reversed` branch needs a ledger row, and the audit must stay consistent. | New informational entry types as in section 3, with the 0057 rule and the audit extended to accept exactly those. |
| O5 | **R7 intervals and channel.** "Defined intervals" and any delivery channel are unspecified, and no alert infrastructure exists. | I will not invent them. | Proposed: 30, 45, 60 and 90 days, then every 30 days; the detector is read-only and delivery is out of scope until you name a channel. Confirm or change. |
| O6 | **R5 authorization.** Is "authorized administrator" exactly "active platform administrator" (the existing check)? And are at least three such administrators guaranteed? | Three-person control is impossible with fewer. | Confirm the existing definition; the executor refuses and records a blocked attempt if it would not be distinct. |
| O7 | **G1 "no other financial effect".** Define the checklist. | Closes ambiguity. | No reservation, application, saga intent, obligation or offset entry for the decision, and no ledger entry other than provisional, vest and expire. |
| O8 | **R9 and case E.** An erroneous plan withdrawn while a provider effect is confirmed (case E) leaves the effect and the credit exactly as they are and lifts the hold, so the existing D4 flow can then record and consume it normally. | Confirms the withdrawal does not reverse a provider effect. | Accept as stated; add an acceptance test. |

## 5. Acceptance matrix

Every row is **NOT STARTED**. Evidence for every row means disposable databases only, a mutation round, and independent review of the exact commit.

| ID | Requirement | Block | Acceptance criteria (tests that must pass) |
|---|---|---|---|
| R1-1 | No cash or provider movement | 1, 2 | The code paths import no provider client; a consumed revoked credit ends as exactly one obligation and no refund row. |
| R2-1 | E1 records the confirmed effect then reverses | 2 | Ledger shows `consume` then `consumed_reversal`; one obligation; buckets and identity correct; lot and decision `reversed`; replay is a no-op. |
| R2-2 | E1 conditions enforced | 2 | Each missing condition (settlement not fulfilled, reversed per O2 rule, no active subscription, effect after deadline, allocation mismatch) yields a blocked attempt and no write. |
| R2-3 | Reserve-block side effect | 2 | After E1 the account refuses a reserve until offsets clear `recovery_due`. |
| R3-1 | C2 evidence accepted | 2 | A `released` saga or an expired unused reservation lets the executor release and then reverse; anything else blocks. |
| R3-2 | C1 and D blocked | 2 | Blocked attempt recorded, nothing written, retry later succeeds once evidence exists. |
| R4-1 | Supersede | 2 | A decision already reversed yields a final `superseded`; a reversal racing the executor produces exactly one financial consequence. |
| R5-1 | Three distinct administrators | 2 | A database check rejects an executor equal to the proposer or approver; an inactive or non-administrator executor is refused. |
| R6-1 | G1 close | 2 | The O7 checklist passes; any extra effect blocks. |
| R6-2 | G2 restore | 1, 2 | Restored amount equals the sum of the decision's `recovery_offset` entries; the obligation and `recovery_due` projection reconcile exactly; never above `units_due`; replay creates nothing twice; an unprovable case blocks. |
| R7-1 | 30-day alerting | 2 | The detector lists items past 30 days and the escalation intervals; it writes nothing and resolves nothing. |
| R8-1 | Append-only storage | 2 | Attempts are insert-only; one final execution per decision enforced by index; update, delete and truncate denied (`ENABLE ALWAYS`). |
| R8-2 | Frozen objects preserved | 1, 2 | The dispute table, and (subject to O1) the hold function, are unchanged by the migrations. |
| R9-1 | Dual-controlled withdrawal | 2 | Two distinct administrators; immutable evidence; after withdrawal the hold lifts (O1) and D4 can settle a case-E effect (O8); an executed recovery cannot be withdrawn. |
| R10-1 | Reversal succeeds for reserved, expired, offset-consumed credits | 1 | The Split 06 reversal commits (or defers per O2) instead of rolling back, with correct ledger identity and audit. |
| R10-2 | Case I | 1, 2 | An executed revocation followed by a settlement reversal returns already reversed with no second effect, in either order. |
| R10-3 | Exactly once under concurrency | 1, 2 | N parallel reversals and executors produce one financial consequence; the loser fails or replays; no deadlock under the shared lock order. |
| X-1 | Inert and dev-only | 1, 2 | Existing write guards unchanged and enabled; no route, queue or cron calls the new code. |
| X-2 | Verification | 3 | PostgreSQL 16 and 18 full integration pass, isolated Partner Award suite passes, mutation round catches every injected defect, independent review approves the exact head. |

## 6. What this document does not authorize

No implementation of any block, no migration, no ledger or lot write, no change to the hold function or the compensator, no release path, no provider call, no Stripe or production access, no activation. Development of Block 1 starts only on your explicit authorization, after you answer O1 to O8. Financial activation, the provider write path, release authority wiring, role hardening, the D1 and D3 decisions, real Stripe test-mode evidence and the 17 PIC/1 scenarios are unchanged and still open.
