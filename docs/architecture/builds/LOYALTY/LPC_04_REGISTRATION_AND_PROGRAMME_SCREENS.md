# LPC-04: registration programme step and Loyalty > Programme screens (Groups 03 and 04)

**Status: IMPLEMENTED, VALIDATION PENDING (local unit, component and contained real-Chromium suites; hosted CI not yet run; no browser run against a live staging or production site).** Stacked on LPC-03 (#626). **No migration.** Development only; no control activated.

## Registration journey
1. Create the account, 2. create the business (name), then registration **continues into the programme step** (`/dashboard/loyalty/programme?setup=1`). The business's **currency and timezone** are still edited in Settings (the TIMEZONE-01 country-assisted picker is a separate, unbuilt design); the programme forms already format amounts in the business currency and describe streaks and off-peak windows in business-local time.
3. **Choose a programme** from the eight cards, 4. **configure** it in its own form, 5. **preview** the customer earning experience (server-side, same shared rules as the till), 6. save a draft or **validate and activate** with an explicit confirmation, 7. continue to the dashboard. **Configure later** is always offered.
- **Configure Later is enforced by the backend, not the screen:** `BusinessService.createBusiness` records the business as `pending` in the same transaction, so a business created through registration earns nothing until its Owner activates a programme, whatever path the person takes. Businesses that existed before programmes keep earning through their backfilled legacy programme. A banner on the Programme page says plainly that customers earn nothing until a programme is active.

## Programme management (Loyalty > Programme)
- Current programme with version, status and a "legacy" flag for backfilled ones; edit (a new immutable version, future events only), pause, retire (never reused); other programmes (draft, validated, paused) with resume or activate; configuration history (events and versions).
- **Switching** is activation of another programme with a panel that states what stays (balances, transactions, earned rewards, tiers, previous programme history), what changes (new activity follows the new programme, history is never rewritten) and what needs consent (progress is kept but not converted; customers join with their next qualifying activity). It requires the confirmation box; the API makes it one transaction and Owner-only.
- A cashier has no route here: the page needs the programme-configuration permission and the API needs `rewards:manage` plus business-wide access.

## Per-type forms (no generic form)
LP-01 stamps (threshold, free-item reward, minimum, **expiry stated explicitly**, reset note), LP-02 fixed points (+ separate check-in points), LP-03 spend and earn, LP-04 milestone ladder (purchases, visits or spend; "not a tier" statement), LP-05 streak (period, periods in a row, grace, evidence, business-timezone note), LP-06 off-peak (weekday checkboxes, local start and end, multiplier or fixed bonus, local effective dates, "a cashier cannot change eligibility"), LP-07 missions (key, goal, target, deadline, reward; no rating or review goal offered). Each has its own component and field names; `buildProgrammeConfig` maps a form to the configuration, the shared rules check it for field-level messages, and the API validates again as the only authority.

## Not complete
- The customer loyalty card per programme, cashier redemption of entitlements and the cashier-side use of the programme are Group 06.
- Currency, timezone and localisation inside the registration wizard itself (Settings still owns them).
- Hosted browser acceptance against a deployed site (only contained fixtures were run).
