# Split 07 — Vesting/Expiry & Consumption Recovery Completion Gate

**Decision: NO COMPLETION LOCK. NO ECONOMIC ACTIVATION.**

This PR adds a Split 07-owned internal `PartnerCreditLifecycleService` with transactional vesting and expiration, including settlement-first locks, claim/reversal verification at vest, 14-day minimum hold, active canonical policy economics, explicit lot/account/decision state validation, UTC anniversary expiry, and deterministic ledger idempotency. No scheduler or client-facing mutation endpoint calls it.

**Recovery gate:** Vesting checks for outstanding recovery obligations and account `recoveryDue` and fails closed if either is positive; it must not silently make a unit available while future recovery has priority. The arithmetic helper is not a durable offset writer.

**Consumption evidence:** The separately authored CE-1 proposal is only a prospective Split 08→Split 07 handoff. No billable consumption record or reservation/consumption writer exists in this PR; consumption cannot be established through metadata or a manually selected lot state. The current compensator continues to reject consumed/reserved/ambiguous lot statuses. There are no new recovery obligations created.

**Ledger/account interpretation:** The `vest` ledger entry records a **bucket transfer** of one from provisional to available, not a second minted credit. `expire` is an irreversible one-unit reduction from available. Reconciliation must count `provisional` origin events as issuance, `vest` as zero-net transfer, `reverse`/`expire` as reductions, and separately balance recovery-offset events.

**Additional release tests required:** expiry and vest concurrency versus settlement reversal, multiple outstanding obligations and ordered offset, positive consumed-credit application and reversals with immutable Split 08 evidence, control-plane permissions, workflow recovery after interruption, ledger/lot projection scans, anniversary policy semantics in all timezones, fresh CI on exact head, and a separately approved DB mutation authorization procedure.

**DB state:** No migration or SQL trigger removal; 0041 still denies production economic writes. Split 08 money and Stripe remain untouched.
