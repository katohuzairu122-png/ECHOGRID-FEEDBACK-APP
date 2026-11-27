# LPC-12 / LPC-13: promotional overlays: inspection and enforcement boundaries

Status: inspection recorded; policy-neutral enforcement library implemented and unit tested. **No stacking, award-selection, cap or budget policy was established.** No migration, no deployment, no feature activation.

## 1. What exists today (inspected in the repository)
| Item | Finding |
|---|---|
| Overlay engine, promotion tables, campaign promotions | **None exists.** There is no promotional overlay table, service, route or screen. |
| Ledger types `referral_bonus` and `birthday_bonus` | Exist in the ledger check constraint and settings columns (`referralBonusPoints`, `birthdayBonusPoints`). Nothing awards a birthday bonus. The only referral award sits in the deprecated `enroll` path, which nothing calls. They are dormant. |
| LP-06 off-peak | Implemented (LPC-03) as a **programme type**: one non-overlapping local time window with a multiplier or fixed bonus, inside the programme's own earning. It is not an overlay and cannot combine with another programme (one active primary programme per business). |
| Reward budgets and per-day limits | Exist for catalogue rewards (exact, LPC-14), not for promotions. |
| Provenance | Programme-generated ledger rows carry programme and version; overlays would carry none today (LPC-01 note). |

## 2. Missing enforcement (the boundaries this block provides as pure, tested functions)
`apps/api/src/loyalty/overlays/overlay-guard.ts` (not wired to any award path, so no behaviour changes):
- **Policy gate**: an `unapproved` policy refuses every overlay (`POLICY_UNAPPROVED`); the policy version is recorded on every decision (policy versioning, audit history).
- **Tenant isolation**: an overlay of another business is never eligible.
- **Expiration**: start inclusive, end exclusive, exact at both edges.
- **Duplicate awards**: a replayed deterministic award key is refused.
- **Customer caps**: reached means refused; no cap stated means none enforced here.
- **Campaign budgets**: exact decimal arithmetic in thousandths (KWD safe); exactly the budget fits, one fils over does not.
- **Compatibility**: with no approved matrix the answer is `COMPATIBILITY_UNDEFINED`, never "all allowed" and never "none allowed".
- **Selection**: `evaluateOverlays` returns every eligible overlay and every refusal and states `selection: 'UNDECIDED'`; it never chooses, ranks or stacks.

## 3. Requirements for the future award path (not built: they need a migration and Owner decisions)
- **Concurrent transactions**: a unique index on the award key, plus the same per-account row lock the earning transaction already takes, so two simultaneous awards cannot both pass the cap or budget.
- **Purchase reversal**: the overlay award must be tied to the triggering purchase so LPC-08 reversal can withdraw it by the same replay rules; unused value withdrawn, used value flagged.
- **Policy versioning and audit**: store the policy version and decision on each award; policy changes append a new version (never edit).
- **Tenant isolation at the database**: composite foreign keys like the programme tables.

## 4. Owner decisions required before any overlay is awarded
1. May overlays stack with each other and with the programme's own earning? Which kinds are compatible (the matrix)?
2. When several overlays are eligible, how is the award chosen (all, best for the customer, earliest, priority)?
3. Customer caps (per what period) and campaign budgets: required or optional, and who sets them.
4. Does an overlay add to or replace programme earning, and does it count toward tiers, milestones, streaks and missions?
5. Expiry semantics for a customer who has already qualified when the overlay ends.
6. Reversal: is an overlay reversed with its purchase automatically?
The platform stacking text (open since LPC-02) belongs to decision 1.
