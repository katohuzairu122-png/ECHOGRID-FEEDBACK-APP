# Split 07 / Split 08 — R10 Block 1: settlement-reversal compensator extension (development record)

**Status: IMPLEMENTED for development only. INERT. NOT ACTIVATED. NOT CERTIFIED FOR FINANCIAL ACTIVATION.** Authorized by the owner's R10 decisions (see [S08_REVOKED_AWARD_ARCHITECTURE_RECONCILIATION.md](S08_REVOKED_AWARD_ARCHITECTURE_RECONCILIATION.md)). The 0041/0042/0053 write guards are unchanged and still deny these writes outside an isolated disposable database. No route, queue or cron calls the new code except the existing Split 06 reversal transaction through the compensator. No provider call, no release path, no production access. **Block 2 (the executor, withdrawal, the hold amendment, the detector and the three-person trigger) is NOT started.**

## What was built

| Piece | Where | What it does |
|---|---|---|
| Shared unwind routine | `src/partner-credits/partner-credit-unwind.ts` | The one routine that unwinds an award, used by the compensator now and by the Block 2 executor later (so they cannot diverge). Takes a **cause**: a settlement reversal event, or a revocation correction. |
| Compensator | `partner-provisional-reversal.compensator.ts` | A thin wrapper over the routine; its public API is unchanged. |
| Deferred-work reader | `partner-credit-deferred-reversal.reader.ts` | Read-only. Derives the pending work of a deferred reversal from persisted state: settlement `reversed`, decision still `vested`, lot `reserved` or `available` (an available lot is a reservation released after the reversal; either way the credit side is unfinished). No deferral table (owner decision O2a). |
| Migration 0058 | `drizzle/0058_r10_settlement_reversal_vocabulary.sql` | Two informational ledger types, their database evidence triggers, the extended lot rule, and an obligation guard (below). |
| Projection audit | `partner-credit-projection.audit.ts` | Three new checks: `REVERSAL_NOOP_EVIDENCE`, `RECOVERY_RESTORED_EVIDENCE`, `OBLIGATION_CONSERVATION`. |

## Behaviour of a settlement reversal, by credit state

| Credit | Before | Now |
|---|---|---|
| provisional, available | `reverse` | unchanged |
| consumed through an invoice | recovery obligation | unchanged (a revocation cause is also supported, audit-compatible) |
| **expired** (G1) | threw, rolled the whole settlement reversal back | one `reversal_noop` entry; lot and decision `reversed`; **no bucket moves**; only if the credit had exactly a provisional, a vest and an expire entry, no other ledger effect and no reservation |
| **consumed by a recovery-offset vest** (G2) | threw | one `recovery_restored` entry reinstating the **exact** offset on its obligation and on `recovery_due` (obligation id and amount come only from the decision's own `recovery_offset` entry); one per decision; blocked if it cannot be proven |
| **reserved** | threw | **commits with the credit left untouched** (`deferred_credit_in_use`); the pending work is derived by the reader; finishing it needs release authority (Block 2 and later) |
| already unwound by an executed revocation (case I) | n/a | `already_reversed`, in either order, exactly one financial consequence |
| anything else, or anything it cannot prove | throws | still throws (fail closed) |

## Database changes (migration 0058)
- Ledger types `reversal_noop` and `recovery_restored`: informational (+1, one per decision), **not** counted in the ledger identity, each with a BEFORE INSERT evidence trigger. The ledger forbids zero units, which is why a no-effect close needs a non-zero informational entry.
- Lot rule (replaces 0057's function; everything else unchanged): `consumed` to `reversed` needs a `consumed_reversal` entry when the lot has a consumed reservation, or a `recovery_restored` entry when it was consumed by an offset; `expired` can only become `reversed`, and only after its `reversal_noop` entry.
- **Obligation guard (new):** before this migration nothing guarded recovery-obligation updates. Now `units_outstanding` may change only to the value its recorded `recovery_offset` and `recovery_restored` entries imply, and nothing else about the obligation may change. The real vest offset already writes its evidence first, so it is unaffected.
- Canonical idempotency: every reversal-class entry uses `partner-reversal:v1:<settlementRef>`, so an executor and a settlement reversal cannot both commit; exactly-once comes from the locks and a state re-check under lock, and the unique key backs it up. A revocation cause writes the correction id into both the obligation's `reversal_ref` and the entry's `metadata.reversalEventId`, so the existing audit join passes, and adds `source` and `correctionId`.

## Decisions applied
O2a (deferred reversal, derived state) and O7 (the G1 checklist) are implemented. O2c (E1 stays blocked for an already-reversed settlement) needs nothing here, because the application writer and consumer still refuse once a settlement is reversed and Block 1 changes neither. R6/G2 and O9 are implemented in the routine; the reserve-block side effect follows from the existing reserve rule. O1, O2b, O5, O6 and R9 are Block 2.

## Reader inventory (acceptance X-3)
No change was needed in `ce1-tenant-integrity.verifier`, `partner-credit-application-integrity.reader` or `partner-credit-terminal-evidence.reader` (they inspect a live consumed credit, have no callers outside tests, and correctly reject a reversed one), `partner-consumption-authority.contract` (it classifies lot status only, and no lot status is added), the multi-unit conservation audit (it does not read ledger types) or `partner-credit.repository` (read-only; its TypeScript type follows the schema). The only source writers of recovery obligations are the vest offset (update) and the compensator (insert).

## Review remediation (independent review of 639f086: CHANGES REQUIRED, no HIGH)
- **MEDIUM-1 saga gate.** The benefit-application saga never read the settlement, so a reserved credit whose settlement had been reversed could proceed to a provider effect. `begin_apply` now refuses with `SETTLEMENT_NOT_FULFILLED` (writes nothing) unless the decision's settlement is `fulfilled`. The read is unlocked by design: the saga keeps its reservation-then-intent lock order and never takes the settlement lock. Residual window: a reversal that commits after the gate read but before the effect is not blocked by the gate; the deferred branch now locks the reservation, so the two serialise at the reservation, and the deferred reader lists the credit for the later (Block 2) executor. The gate narrows the window; it does not claim to close it.
- **LOW-2 reader.** Also lists a vested award on a reversed settlement whose lot is `available`.
- **LOW-3 deferred branch.** Locks the account then the reservation and validates (account reserved bucket at least 1; reservation `reserved` and for the same business, decision and account) before deferring; otherwise fails closed with `PARTNER_REVERSAL_LOT_STATE_UNSUPPORTED`.
- New tests: saga refusal and recovery; reader lists an available lot and still excludes expired and provisional; deferred branch waits on a held reservation lock; deferred branch fails closed on a missing reservation or an empty reserved bucket. Each fix was mutation-checked (gate disabled, lock removed, validation removed, reader filter reverted): every mutant failed exactly the new test.

## Hardening block (certification LOW-A, LOW-B, LOW-C; migration 0059)
- **LOW-A1/A2 (test gaps).** New regression tests: an already-reversed decision without its canonical `partner-reversal:v1:<settlementRef>` ledger row fails closed (an unrelated entry or a wrong key does not satisfy it; correct replays are idempotent and add nothing); `recovery_restored` evidence must match the recorded offset's obligation, decision, account and exact units (a fabricated two-unit offset cannot be restored with one unit), and no restoration can exceed the obligation. Both original mutation survivors are now detected.
- **LOW-B.** `partnerCreditLedgerEntrySchema` now uses the exported `partnerCreditLedgerEntryTypes` (the ten types of `partner_credit_ledger_type_check`); a live-constraint pin test makes drift fail. The schema had no importers, so no API contract changed.
- **LOW-C.** Migration 0059 adds `partner_credit_recovery_obligations_no_delete`, BEFORE ROW DELETE, ENABLE ALWAYS, raising `PARTNER_CREDIT_OBLIGATION_DELETE_DENIED`. Unconditional: the only writers are the compensator insert and the guarded `units_outstanding` update, and the account foreign key is RESTRICT. It denies every role holding DELETE and replica-role sessions; it does NOT bind a superuser or table owner who can disable triggers (role hardening, a separate block).

## Existing tests changed (purpose unchanged)
Two tests asserted that a settlement reversal of a reserved credit is rejected; under owner decision O2a it now commits and defers, so they now assert exactly that, that nothing is written, and that no double-spend can occur: the D4 "merely RESERVED" regression, and the isolated award suite's reservation-versus-reversal race (the reservation-first branch now expects the reversal to commit with the credit still reserved, listed by the reader).

## Evidence (disposable databases only)
- `partner-credit-unwind.integration.test.ts` (new): each case, the database evidence triggers, the lot rules, the obligation guard, the audit, parallel unwinders of mixed causes on a real PostgreSQL scratch database; plus a revocation-cause consumed-credit test in the consumption suite.
- Hand-run mutations on the routine, the migration, the audit and the reader (the first round left three survivors, which got their own tests; all injected defects are now caught). These injections are not part of the repository's tests.
- Independent review, PostgreSQL 16 and 18 results and CI are recorded on the pull request.

## Not done, not authorized
The revocation executor, append-only execution storage, withdrawal and the narrow hold-function amendment (O1), three-person execution (O2b, O6), the R7 detector and its escalation, any release path, any provider write, any production access, and financial activation (NO-GO).
