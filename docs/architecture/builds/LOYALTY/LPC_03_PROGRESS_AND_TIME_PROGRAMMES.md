# LPC-03: LP-04 milestones, LP-05 streaks, LP-06 off-peak, LP-07 missions

**Status: IMPLEMENTED, VALIDATION PENDING (local disposable PostgreSQL 16, unit and integration suites; hosted CI not yet run).** Stacked on LPC-01 (#624) and LPC-02 (#625). **No migration**: it uses the 0107 tables. Development only; no control activated.

## Shared rules (packages/shared-types/src/loyalty-engines.ts; the web preview uses the same code)
- **Business-local time.** A period is the business's IANA-timezone calendar day or Monday-based week, derived from the SERVER-recorded instant. The database UTC day is never used (23:30 UTC is already tomorrow in Kuwait). An instant has exactly one local reading, so daylight-saving gaps and overlaps cannot double-count or skip a day (tested across the New York spring-forward and fall-back days).
- **No caller-supplied time.** The purchase API has no timestamp input; the stored instant is the database clock. A cashier or customer cannot move eligibility.
- **Rewards earned as prizes** (milestone, streak, mission) must be an ACTIVE free-item, discount or voucher reward of the same business; a points-cost reward is never a prize (checked on every save, validation and activation).

## LP-04 Milestone rewards
`metric` = purchases (verified receipts, optional minimum amount), visits (check-ins) or spend (cumulative exact amount, KWD three digits). Strictly ascending thresholds, each with its own reward; each threshold is granted once for the life of the programme (unique entitlement key `milestone:<threshold>`); one big purchase can cross several. **A milestone never changes a membership tier** and the configuration has no tier field.

## LP-05 Streak rewards
`period` day or week, `requiredPeriods` (2 to 365), `gracePeriods` (0 to 3 missed periods tolerated), evidence = purchase or visit. Several events in one period count once; a gap beyond the grace breaks the streak (recorded) and the event starts a new one; an older late event changes nothing; completing a streak grants one entitlement and starts again.

## LP-06 Off-peak rewards
The programme itself earns: base points per currency unit (as LP-03) plus, inside ONE non-overlapping local time window, a multiplier (1 to 10, two decimals) or a fixed bonus. Windows are local wall-clock times with weekdays (end after start on the same day; a window crossing midnight is split), optional inclusive local effective dates. Exact integer arithmetic: floor(amount x rate x multiplier). No stacking between windows (they cannot overlap) and no overlay is combined (RW-D5).

## LP-07 Missions
Up to ten missions, each with an objective (purchases, spend or visits), an exact target, a deadline in days from the first qualifying event, an optional minimum receipt, and a reward. A completed mission never pays twice; an unfinished one that passes its deadline restarts with the next qualifying event. Objectives are a closed list: ratings, reviews and feedback can never be a condition (RW-D6), and no customer-supplied or executable rule exists.

## Integrity
All four run in the same transaction as the purchase or check-in, under a row lock on the customer's progress. Each verified event is applied once (an `applied` marker unique per programme), every step is appended to the progress history, and every reward is a unique entitlement. Racing receipts never lose progress or double a reward (tested with separate connections). A paused (frozen) programme ignores events; its counters are kept, never converted.

## Not complete / not claimed
- **Reversal** of a purchase (and of milestone, streak and mission progress it caused) needs the platform reversal service; recorded as a separate block.
- **Cashier redemption** of earned entitlements and the **customer card** for each programme: integration block.
- **Visit evidence** is the QR check-in (the approved visit mechanism); a stricter visit-verification model, if wanted, is an Owner decision.
- **Re-enrolment** after a switch (RW-D2 re-onboarding model) is still an open citation; progress begins at the next qualifying event.
