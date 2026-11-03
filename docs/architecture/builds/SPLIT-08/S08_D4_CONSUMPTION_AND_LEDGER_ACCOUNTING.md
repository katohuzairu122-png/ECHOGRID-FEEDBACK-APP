# Split 08 / Split 07 — D4 final credit consumption and ledger accounting

**Status: IMPLEMENTED for development only. INERT. NOT ACTIVATED. NOT CERTIFIED.** Every write guard from migrations 0041/0042/0048 is unchanged and still denies these writes outside an isolated disposable database. No route, queue, cron or webhook calls any of this code. No Stripe call, no production resource, no balance change. Implements the design already written in [CE1_AUTHORITATIVE_RESERVATION_CONSUMPTION_FREEZE_GATE](../SPLIT-07/CE1_AUTHORITATIVE_RESERVATION_CONSUMPTION_FREEZE_GATE.md), [CE1_RESERVATION_TERMINAL_APPLICATION_SOURCE_OF_TRUTH](CE1_RESERVATION_TERMINAL_APPLICATION_SOURCE_OF_TRUTH.md) and the Split 07 consumption evidence contract. It does **not** freeze CE-1 and does not grant economic activation.

## What was built

| Piece | Where | What it does |
|---|---|---|
| Ledger vocabulary + invariants | `apps/api/drizzle/0053_split07_08_d4_consumption_ledger.sql` | Adds ledger types `consume` (-1, counted in the ledger identity) and `consumed_reversal` (+1, informational: a debt is not a balance). Exactly -1 / +1 by CHECK; at most one of each per decision by partial unique index. Existing types, rows, triggers and the append-only guard are untouched. |
| Database evidence verifier (CE-1 "database-queryable") | same migration, triggers | A reservation can become `consumed` only if the Split 08 terminal application row **and** the saga intent in the reconciled `consumed` state (same provider effect, same invoice) exist for it. `consumed` and `released` are terminal. A lot becomes `consumed` only from `reserved` and after its reservation; a consumed lot can only become `reversed`. A `consume`/`consumed_reversal` ledger row needs a consumed reservation of that decision and account. |
| Split 08 terminal application writer | `src/billing/benefit-terminal-application.service.ts` | Records the one immutable application row from rows Split 08 already owns: reconciled saga, frozen allocation (amount, invoice, currency), `active` subscription, effect confirmed no later than the reservation deadline. Never touches lots, accounts or the ledger. |
| Split 07 consumption writer | `src/partner-credits/partner-credit-consumption.service.ts` | One transaction, lock order settlement → decision → lot → account → reservation. Re-reads and re-verifies the application and saga, then: reservation `consumed`, lot `consumed`, `reserved` -1, one `consume` ledger entry (`partner-consume:v1:<reservationId>`). Idempotent; a lost race against reversal, release, expiry or a dispute hold fails closed. |
| Consumed-credit reversal | `src/partner-credits/partner-provisional-reversal.compensator.ts` | A Split 06 reversal reaching an already-consumed credit now originates exactly one recovery obligation (keyed by the reversal event), a `consumed_reversal` entry, `recovery_due` +1, and marks lot and decision reversed. The consumed reservation, application and `consume` entry are never edited. Reserved, expired and other states still fail closed as before. |
| Projection audit | `src/partner-credits/partner-credit-projection.audit.ts` | Ledger identity now counts `consume`; new checks `CONSUMED_LOT_EVIDENCE`, `CONSUME_ENTRY_WITHOUT_LOT`, `CONSUMED_REVERSAL_EVIDENCE`. |

## Decisions that are MINE and need owner ratification

The documents leave these open ("D4: ledger vocabulary ... undecided"). I made the smallest consistent choice; each is reversible before activation.

1. **Ledger vocabulary.** No existing entry type can record a unit leaving the buckets while keeping the audited identity, so two types were added (above). A consumed-credit reversal cannot reuse `reverse` (it would double-count a unit that already left) and so uses an informational `consumed_reversal`.
2. **Consumption is refused while an award dispute hold is active.** The unit stays reserved until the hold resolves. (A provider effect may already exist; this is a bookkeeping hold, not a reversal of money.)
3. **An effect confirmed after the reservation's own deadline is not recorded or consumed.** It fails closed for review rather than silently consuming an expired reservation.
4. **Only an `active` subscription is eligible** to receive a recorded application (the documents say "verified active/eligible subscription"; "eligible" is read as `active`).
5. **The allocation's amount, invoice and currency must match the saga intent.** The allocation policy itself is pinned to `S08-AGG-ROUND/1` by the existing database CHECK; it is deliberately *not* compared with the benefit policy (`PC-BENEFIT/1`), which is a different concept.

## What this does NOT do (still blocked or unbuilt)

- **No activation.** The guards are not removed; `consumption_authorized` on allocation freezes stays false by CHECK.
- **No provider write path.** Nothing here calls Stripe or applies a benefit; the saga reaches `consumed` only from a provider observation, and no mutating provider exists.
- **No release path.** `release` still throws `SPLIT08_RELEASE_AUTHORITY_NOT_ESTABLISHED`.
- **D1, D3 and the economic defaults remain owner decisions** (benefit instrument beyond the development choice, settlement-evidence fields, intervals/trials/rounding sign-off).
- **No end-to-end test against real Stripe test mode**; the 17 PIC/1 activation scenarios remain NOT CERTIFIED.
- **Recovery-offset interplay** (a later vesting credit offsetting the new obligation) uses the existing, unchanged offset writer; it is not re-tested here beyond the ledger identity.

## Evidence (development, disposable databases only)

`apps/api/test/integration/partner-credit-consumption.integration.test.ts` — 25 tests against a real scratch PostgreSQL: inert by default (guards proven enabled first), vocabulary and invariants, the database refusing evidence it cannot find, terminal-state finality, the application writer's accept/refuse matrix, consumption happy path, exactly-once under 8 parallel consumers, same-account serialisation, every refusal path, rollback on mid-transaction failure, consumed-credit reversal (obligation, idempotency, missing evidence, regression for reserved lots, no second obligation), and the audit catching broken evidence. Ten deliberate defects were injected into the code; each is caught by at least one test.
