# LPC-07: the customer's card for the active programme

Status: implemented, validation pending Owner merge. No migration, no deployment, no feature activation.

## What the customer sees
On the business page in their wallet (`/loyalty/dashboard/:businessId`), below the points and tier card, a **Your rewards programme** card adapts to the business's active programme:

| Programme | Card |
|---|---|
| LP-01 stamp card | stamps x of N, reward name, expiry of the current card (or "expired"), cards completed |
| LP-02 / LP-03 points | nothing extra (the points balance and tier progress already are the card) |
| LP-04 milestones | progress to the next rung, the whole ladder with earned / not yet |
| LP-05 streak | streak x of N days or weeks, grace rule, reward |
| LP-06 off-peak | the public time windows and multipliers or bonuses, end date |
| LP-07 missions | each mission: progress, status (not started, in progress, completed, time ran out), end date, reward |

Rewards earned and not yet received are listed by name and expiry ("show this screen to the cashier").

## API
`GET /loyalty/me/accounts/:businessId/programme` (customer session). Identity comes from the session; a customer with no account at that business gets the uniform `LOYALTY_ACCOUNT_NOT_FOUND`. The response carries only the customer's own progress, the programme's public terms, reward names from the business catalogue and the business currency. No entitlement, account, customer or user id is returned.

## Design notes
- `programmeCardView` (shared-types) is pure and locale-neutral; counters are read defensively (an unexpected value is an empty card, never a larger one); expiry uses the server clock.
- A frozen progress row (programme switched away) is shown as empty; counters are never converted (RW-D2).
- The page treats the card as optional detail: an API that predates it, or any failure, hides the card and never breaks the page.
- en/es/fr/ar.

## Verification
API unit 290 files / 4,609; web unit 183 files / 1,517; new pure-view tests (8), component tests (8), integration test on PostgreSQL (stamps, completion, other customer, other business). tsc and eslint clean. Hosted CI pending.

## Open
Purchase reversals that revoke rewards; tiers and reward catalogue (Group 05); customer-side wording review by the Owner.
