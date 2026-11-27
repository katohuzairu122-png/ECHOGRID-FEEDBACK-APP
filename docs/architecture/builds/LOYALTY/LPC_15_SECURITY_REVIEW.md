# LPC-15: independent security review of the loyalty programme lifecycle

Method: adversarial and concurrent scenarios on disposable PostgreSQL (`loyalty-security-review.integration.test.ts`, `loyalty-lifecycle-acceptance.integration.test.ts`), code reading of the earning, entitlement, reversal, reward-catalogue and cashier-scope paths, and the existing RBAC and cashier allow-list suites. Scope: merged code on `main` plus the open PRs listed in LPC-17. Nothing was run against staging or production.

## Demonstrated defect (fixed in this PR)
| # | Finding | Evidence | Fix |
|---|---|---|---|
| F1 | **Reversal reported a hand-over reward as "revoked".** The reversal read an earned reward as `available`, then ran a conditional update; if the cashier's hand-over committed between the two, the update changed zero rows but the code still counted a revocation. The result and audit trail then said "revoked" for a reward the customer had received, hiding the "already handed over, review needed" flag the Owner requires. | Deterministic interleaving test (a second transaction holds the reward, the reversal waits, the hand-over commits): failed with `revokedEntitlements = 1`, expected 0. A 40-round free race did not reproduce it (the window is tiny), which is why the deterministic probe was needed. | The revocation now counts only rows the database actually changed; if none changed and the reward is `redeemed`, it is reported as already used. Probe and free-race tests pass. |

## Reviewed, no defect found (evidence)
| Area | Result |
|---|---|
| Cross-tenant access | A business cannot reverse another's purchase (`PURCHASE_NOT_FOUND`), redeem or list another's reward (`LOYALTY_ACCOUNT_NOT_FOUND` or `ENTITLEMENT_NOT_AVAILABLE`), or read another's programme card; customer card identity comes only from the session. |
| Unauthorized reversal | API requires `loyalty:adjust` plus business-wide access; the cashier route allow-list is exactly nine routes and contains no reversal, preview or purchase-history route (tests). UI gates are presentation only. |
| Cashier privilege escalation | Cashier tokens reach only the nine counter routes; the entitlement hand-over re-resolves the QR token server-side and uses the freshly resolved account, never a posted id; programme routes are Owner-only. |
| Duplicate reward awards | Entitlements have a unique key per programme, account and source; progress markers are unique per programme and event; concurrent purchases do not double-grant. |
| Concurrent redemption | Single conditional update; one winner (existing race test); reversal versus hand-over racing 40 rounds always consistent. |
| Concurrent purchases and reversals | Six reversals and purchases racing on one account: no deadlock, no negative balance, ledger sum equals the balance. |
| Reward catalogue manipulation | Active-programme rewards cannot be switched off, retyped or deleted; rewards with waiting customers cannot be deleted (LPC-09). |
| Negative balances | Reversal stops at zero and records the shortfall; the database also forbids a negative balance. |
| Replay | A reversed receipt's idempotency key cannot re-earn (`IDEMPOTENCY_CONFLICT`); progress events are replay-safe. |
| Ledger mutation | Reversal appends a negative adjustment and a `reversed` progress event; nothing is updated in place except the purchase status and an unused reward's status, both guarded by database triggers. |
| Promotional abuse | No overlay engine exists; the LPC-12/13 boundaries fail closed until the Owner decides policy. |
| Monetary precision | Exact integer arithmetic; fourth decimals refused; KWD three decimals via migration 0108 (LPC-14, prepared, not applied). |
| Frozen programmes | A switched-away programme's counters never change; a reversal reports it as frozen rather than altering it; its already-earned rewards stay redeemable by design. |

## Observations (not defects)
- The reversal preview runs the real reversal in a rolled-back transaction, so it briefly holds row locks on the purchase, account and progress rows. Repeated previews by an authorised Owner can briefly queue other writes on that account; bounded by the transaction time. Rate limiting the route would be a hardening option.
- Earned rewards of a deactivated reward can still be handed over (intended: customers keep what they earned).
- A reversal after a switch-away reverses points but not frozen programme progress (documented limit in LPC-08).

## Separate infrastructure dependency: the restricted runtime database role
`echogrid_app_runtime` is **not provisioned** on staging or production (re-verified read-only on 2026-11-27: absent on both; the connecting role is `neondb_owner` on both). The Workers therefore run as the table owner. Consequences for the loyalty lifecycle: the append-only and entitlement guards are triggers, and an owner can disable or replace triggers, grants and functions, so these protections defend against defects and non-owner roles but not against a compromised application credential. The design, manifest and verification SQL exist (`apps/api/scripts/runtime-role/`, `CASHIER-PROD-R8G-NONOWNER-RUNTIME.md`) and were exercised on a 0085-level schema (1,528 tests under the restricted login). **They have not been re-verified at the current schema level** (migrations through 0108, 42 additional Tentaship tables, programme tables). Provisioning, the Hyperdrive reconfiguration and any credential change need separate Owner authorization; nothing here changes a deployed role.

## Recommendation
Merge this PR with the lifecycle acceptance suite. Treat runtime-role provisioning as a pre-activation prerequisite for any feature that moves value (Shuffle, Drops, Badges awards); it is not required to keep the loyalty programme running as released.
