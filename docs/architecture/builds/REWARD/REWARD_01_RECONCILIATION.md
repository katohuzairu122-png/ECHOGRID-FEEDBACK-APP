# REWARD-01: loyalty and reward reconciliation (audit only)

**Status: AUDIT RECORD plus owner rulings RW-D1 to RW-D8 (section 7) and the REWARD-02A implementation specification (section 8). Documentation only. No code, schema, migration, deployment or Cloudflare change. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged.**
Baseline: `main` `3ec57a01` (2026-11-13). Open PR at audit time: #411 (impersonation gate, unrelated to loyalty). Labels: **VERIFIED** (read in source), **NOT AUDITED** (not read in this block), **PROPOSED**.

## 1. What was inspected (VERIFIED)

`apps/api/src/db/schema/loyalty-settings.ts`, `loyalty-rewards.ts`, `loyalty-transactions.ts`, `loyalty-purchase-events.ts`, `loyalty-tiers.ts`; `apps/api/src/loyalty/*` (account, reward, redemption, tier services and routes); the web loyalty pages under `apps/web/src/app/dashboard/loyalty/` (scan, redeem, rewards, tiers, settings); the shared reward types; `ECHO_GRID_SPLIT_03_LOYALTY_QR_CORE_v1.0.md`. Not read in depth: Split 06 and 07 internals, customer-side loyalty pages, the database triggers.

## 2. Existing model (VERIFIED)

Membership, then loyalty account, then qualifying event, then ledger entry, then projection (Split 03 frozen model). Per business `loyalty_settings` holds four numbers only: `pointsPerCheckin`, `pointsPerCurrencyUnit`, `referralBonusPoints`, `birthdayBonusPoints`. There is **no program-type field**, so no "one active primary program" concept exists. Ledger types found: checkin, purchase, referral_bonus, birthday_bonus, adjustment, plus redemption rows. Purchases are stored as events with one amount and an idempotency key; there is no item or product detail.

## 3. Reconciliation matrix

### 3.1 Primary programs

| ID    | Program                                                  | Classification                                 | Evidence                                                                                                         |
| ----- | -------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| LP-01 | Buy X, get Y free                                        | **NOT IMPLEMENTED**                            | No stamp or purchase counter, no X/Y fields.                                                                     |
| LP-02 | Fixed points per purchase                                | **PARTIALLY IMPLEMENTED**                      | Fixed points exist per check-in (`pointsPerCheckin`); no fixed award per purchase.                               |
| LP-03 | Spend-and-earn points                                    | **PARTIALLY IMPLEMENTED**                      | Purchase earns `floor(amount x pointsPerCurrencyUnit)`. Precision caveats in section 4.                          |
| LP-04 | Milestone rewards                                        | **PARTIALLY IMPLEMENTED**                      | Tiers exist (`min_points`, free-text `benefits`). No transaction-count or spend milestones, no automatic unlock. |
| LP-05 | Streak rewards                                           | **NOT IMPLEMENTED**                            | No streak state or reset rules.                                                                                  |
| LP-06 | Off-peak rewards                                         | **NOT IMPLEMENTED**                            | No time-window rule.                                                                                             |
| LP-07 | Mission / challenge                                      | **NOT IMPLEMENTED**                            | No challenge model.                                                                                              |
| LP-08 | Product-specific loyalty                                 | **NOT IMPLEMENTED; BLOCKED BY OWNER DECISION** | Purchases carry no item data; needs a product-capture decision.                                                  |
| n/a   | One active primary program per business, switching rules | **NOT IMPLEMENTED; BLOCKED BY OWNER DECISION** | No program selector exists; switching and re-onboarding rules are not decided.                                   |

### 3.2 Reward types

Reward `type` is limited by a database check to `points`, `discount`, `free_item`, `voucher`. Rewards have `pointsCost`, one `rewardValue` (numeric 10,2), `maxBudget`, per-day cap, `limitPer` (receipt, visit, period), start and expiry dates, branch scope, cooldown, feedback-minimum fields and an optional visit-verification flag.

| ID    | Type       | Classification               | Notes                                                                                                                                                          |
| ----- | ---------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-01 | Points     | **FULLY IMPLEMENTED (core)** | Cost, redemption code, staff confirmation, limits. Deep lifecycle tests NOT AUDITED.                                                                           |
| RW-02 | Discounts  | **PARTIALLY IMPLEMENTED**    | One `rewardValue`; no percent-versus-fixed unit field, no minimum-spend, no cap other than `maxBudget`.                                                        |
| RW-03 | Free items | **PARTIALLY IMPLEMENTED**    | Type exists; no product link and no stamp count (so "buy 4, get the 5th free" is not expressible).                                                             |
| RW-04 | Vouchers   | **PARTIALLY IMPLEMENTED**    | Type and unique `redemptionCode` per redemption exist; a separate voucher entity with its own expiry and single-use state was not found. NOT AUDITED in depth. |

### 3.3 Promotional overlays

| Overlay                    | Classification                                 | Evidence                                                                                                               |
| -------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Birthday / anniversary     | **DATA ONLY**                                  | `birthdayBonusPoints` setting and a `birthday_bonus` ledger type exist; no award path was found.                       |
| Bonus earning promotions   | **NOT IMPLEMENTED**                            | No campaign multiplier.                                                                                                |
| Product promotions         | **NOT IMPLEMENTED; BLOCKED BY OWNER DECISION** | Needs item data.                                                                                                       |
| Referral rewards           | **PARTIALLY IMPLEMENTED**                      | `referralBonusPoints` is awarded at enrollment when a referrer exists; attribution and abuse rules are not documented. |
| Branch-specific promotions | **PARTIALLY IMPLEMENTED**                      | Rewards carry `branchId` and start/expiry dates; no campaign object.                                                   |

### 3.4 Other areas

| Area                         | Classification                    | Notes                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Community Points boundary    | **NOT AUDITED in this block**     | Splits 06 and 07 documents exist (orphan settlement, consumption evidence); no cross-ledger conversion was looked for or built.                                                                          |
| Business dashboard           | **PARTIALLY IMPLEMENTED**         | Pages for scan, redeem, rewards, tiers, settings exist. Program selection and campaign pages do not.                                                                                                     |
| Cashier "Serve customers"    | **IMPLEMENTED (not re-audited)**  | D-C1 permissions unchanged.                                                                                                                                                                              |
| Customer view                | **NOT AUDITED**                   | Customer pages not read here.                                                                                                                                                                            |
| Reversal and recovery        | **PARTIALLY IMPLEMENTED**         | Corrections use `adjustment` entries (compensating, append-only). No reversal for a redemption was found in the loyalty services. NOT AUDITED in Split 07.                                               |
| "Split 08 loyalty isolation" | **RECONCILED (RW-D8, section 7)** | Split 08 is **billing and subscription compensation**, deferred (Split 06 specification and completion report). It is not a loyalty isolation specification. See section 7 for the canonical references. |

## 4. Findings that matter before any build

1. **KWD precision (VERIFIED).** Kuwaiti dinar has 3 decimals. Purchase amounts (`qualifying_amount`), `reward_value` and `max_budget` are `numeric(x,2)`, and the service rounds with `toFixed(2)` and a 2-decimal helper. A business with `default_currency` KWD would lose the third decimal. Fixing this needs a schema change and its own authorization.
2. **Points use floating-point multiplication (VERIFIED).** `Math.floor(purchaseAmount * Number(pointsPerCurrencyUnit))` on JavaScript numbers. Exact-decimal arithmetic is required for monetary rules; the reward service already documents the same concern elsewhere.
3. **"Buy 4 get 5th free" and "spend 10 KWD for 20% off" cannot be configured today** (consistent with section 3).
4. **No redemption reversal** found in the loyalty services (section 3.4).

## 5. Owner decisions needed (BLOCKED)

- Program selector: one active primary program per business, and what happens to existing balances and progress when a business switches.
- Item-level purchase capture (for LP-08 and product promotions).
- Stamp rules: what counts, reset, expiry, one stamp per receipt.
- Stacking rules between a primary program, rewards and overlays.
- Referral attribution and abuse limits; birthday verification.
- Currency precision: approve the 3-decimal change (migration) for KWD.
- ~~Which specification "Split 08 loyalty isolation" refers to~~ (answered, RW-D8).

**After the 2026-11-13 rulings (section 7):** program selector, switching, stamp baseline, stacking default, referral and birthday principles, item-level verification direction and currency precision are **decided** at principle level. Still open: the exact stamp expiry and reset values, the list of three-decimal currencies beyond KWD, who defines business stacking configuration, and the platform stacking policy text.

## 6. Proposed next blocks (superseded in part by section 8) (PROPOSED; each needs authorization; none started)

- **REWARD-02A:** exact-decimal money handling and 3-decimal support (schema plus service), no behavior change for 2-decimal currencies. Needs migration authorization.
- **REWARD-02B:** stamp program (LP-01) behind a per-business setting, after the stamp rules above are decided.
- **REWARD-03:** discount rule fields (percent or fixed, minimum spend, cap).
- Then overlays, then UI, then security regression, per the directive. The established roadmap order governs: WEB-1102, ACCESS-SEC-01 and the access-model blocks come first unless the owner reorders.

## 7. Owner rulings, 2026-11-13 (RECORDED; documentation only)

The owner's numbering D1 to D8 is carried here as **RW-D1 to RW-D8** so it does not clash with the access-model decisions D1 to D6. These rulings authorize documentation and the REWARD-02A specification only. **No implementation, migration, deployment or merge is authorized by them.**

| ID    | Ruling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RW-D1 | Each business runs **one active primary loyalty program** (LP-01 to LP-08). Promotional overlays are not primary programs.                                                                                                                                                                                                                                                                                                                                                                                                 |
| RW-D2 | Switching needs **explicit business-owner authorization**. Balances, earned rewards and history stay intact. Progress is never silently converted; customers explicitly enroll in the replacement under the approved re-onboarding model. Historical ledger entries are never rewritten. (The re-onboarding model is referenced by the owner; no canonical document for it was located in this audit, so it must be cited before REWARD-02B.)                                                                              |
| RW-D3 | Item-level purchase data is a **future capability**: business-owned product records, each purchase line tied to a trusted source, duplicate receipts and replays rejected. Product-specific loyalty stays disabled until those controls exist.                                                                                                                                                                                                                                                                             |
| RW-D4 | LP-01 baseline: one stamp per verified eligible receipt; configurable threshold and reward item; no duplicate stamps; no transfer between businesses; atomic, idempotent redemption; auditable completed cycles; **expiry and reset must be explicitly configured before activation**. Example: buy 4 eligible coffees, the 5th is free.                                                                                                                                                                                   |
| RW-D5 | **No automatic stacking.** Combining benefits on one transaction needs an explicit, documented business configuration and platform policy. The same reward or promotion is never applied twice.                                                                                                                                                                                                                                                                                                                            |
| RW-D6 | Referral bonuses need verified attribution and anti-abuse controls (no duplicate accounts, repeated enrollment or self-referral). Birthday rewards need a verified eligible date and a configured award period. Ratings and positive feedback are never eligibility requirements.                                                                                                                                                                                                                                          |
| RW-D7 | **Approved: exact-decimal arithmetic and three-decimal KWD support** (architecture and preparation only). KWD supports three fractional digits; two-decimal currencies unchanged; no floating-point money arithmetic; history preserved; additive or safely reversible migration; no reinterpretation of historical amounts; every affected column and calculation validated; no premature rounding; currency-aware rounding at the correct transaction boundary. **Executing the migration needs its own authorization.** |
| RW-D8 | Split 08 is **not** the loyalty isolation specification. The real references are below. Existing business-level ledger isolation and Community Points separation are unchanged.                                                                                                                                                                                                                                                                                                                                            |

### RW-D8 canonical references (VERIFIED by document search)

- **Split 03** (`SPLIT-03/ECHO_GRID_SPLIT_03_LOYALTY_QR_CORE_v1.0.md`): the frozen loyalty model, membership, then loyalty account, then qualifying event, then ledger entry, then projection; append-only history with compensating corrections.
- **Split 01** (`SPLIT-01/...IDENTITY_CUSTOMER_RELATIONSHIP_v1.0.md`): customer and business membership and consent; customer and staff identity systems stay isolated.
- **Split 05** (`SPLIT-05/...COMMUNITY_POINTS_v1.0.md`): Community Points, with an isolation section (balance and history APIs isolated).
- **Split 06** (`SPLIT-06/...ORPHAN_SETTLEMENT_v1.0.md`): orphan reward settlement.
- **Split 08** is deferred "Billing / subscription compensation" (subscription credit application, invoice offsets, Stripe adjustments, accounting reconciliation, billing reversal propagation), per the Split 06 specification and completion report. No document titled "loyalty isolation" exists; business-level loyalty isolation is a property of the Split 01 and Split 03 membership-and-account model.

## 8. REWARD-02A specification: exact decimals and KWD precision (PROPOSED, NOT IMPLEMENTED)

Baseline verified 2026-11-13: `main` `3ec57a01`, latest migration `0068`, so the next number is `0069` (**re-verify at execution**; PR #411 and others may add migrations). Dependencies: the owner authorizes the build, then separately authorizes the migration (staging first, production through `migrate-production.yml`, with a database snapshot beforehand). Nothing below is invented policy; open items are flagged.

### 8.1 Columns (VERIFIED in the Drizzle schema and migration 0036)

| Column                                      | Today                  | Proposed                                                           |
| ------------------------------------------- | ---------------------- | ------------------------------------------------------------------ |
| `loyalty_purchase_events.qualifying_amount` | numeric(10,2) NOT NULL | numeric(11,3)                                                      |
| `loyalty_rewards.reward_value`              | numeric(10,2) NULL     | numeric(11,3)                                                      |
| `loyalty_rewards.max_budget`                | numeric(10,2) NULL     | numeric(11,3)                                                      |
| `loyalty_transactions.purchase_amount`      | numeric(10,2) NULL     | numeric(11,3)                                                      |
| `loyalty_settings.points_per_currency_unit` | numeric(6,2)           | **unchanged**: it is a rate (points per currency unit), not money. |

Eleven total digits with three fractional keeps the same eight integer digits as today. Existing CHECK constraints (`> 0`, `IS NULL OR > 0`) stay valid. **Not audited, must be enumerated before the migration:** views, triggers, indexes and other tables or functions that reference these columns, and the orphan settlement tables.

### 8.2 Code that does money arithmetic today (VERIFIED)

- `loyalty/loyalty-account.service.ts`: `input.purchaseAmount.toFixed(2)` (about line 165) and `Math.floor(input.purchaseAmount * Number(settings.pointsPerCurrencyUnit))` (about line 200).
- `loyalty/loyalty-reward.service.ts`: `roundMoney()` is `Math.round(amount * 100) / 100`; `toFixed(2)` for `rewardValue` and `maxBudget` (about lines 307 and 312).
- `loyalty/budget-limit.ts`: converts to integer **cents** with `CENTS_PER_UNIT = 100` and `Math.round(Number(value) * 100)`; used by the redemption service budget check.
- Shared types: `purchaseAmount`, `rewardValue`, `maxBudget` inputs are `z.number().positive().max(1_000_000)`; output DTOs return decimal strings.
- Currency: `businesses.default_currency` (ISO 4217, default USD). `apps/web/src/lib/currencies.ts` lists codes (KWD included) but **no per-currency decimal-places table exists** anywhere.

### 8.3 Design

1. **One money module** (shared types or an API lib): `currencyExponent(code)` (KWD = 3, default 2, unchanged for every other currency until the owner extends the list); parse a decimal string or number into an integer count of minor units using exact string handling; `format(minor, code)`; `multiplyByRate` using integer or BigInt arithmetic. No `Number` arithmetic on money.
2. **Input boundary:** accept decimal strings, and numbers by converting through their shortest decimal string. Reject more fractional digits than the currency allows (no silent rounding), non-finite values, exponent notation, zero and negatives. The existing maximum of 1,000,000 stays.
3. **Points:** `points = floor(amountMinor x rate / (10^exponent x 10^rateScale))`, exact. Floor is the current rule and is kept; the remainder is discarded, as today. **Behavior note for the owner:** the old float expression can differ from the exact result by one point in rare artifact cases; the exact result governs and each such difference must be listed in the test evidence.
4. **Budget guard:** `budget-limit.ts` switches from cents to the currency's minor unit (mills for KWD); comparisons stay exact integers.
5. **Rounding:** none at input. Rounding occurs only at documented points: points use floor; percent discounts are REWARD-03 and not decided here.
6. **API output:** serialize to the business currency's digits (so a USD business still sees `9.10`, a KWD business sees `9.100`); never expose the extra zero to two-decimal currencies. Input remains backward compatible for two-decimal values.
7. **Migration `0069` (not executed):** `ALTER COLUMN ... TYPE numeric(11,3)` on the four columns. Values are preserved numerically (1.10 becomes 1.100). It may rewrite the tables; the tables are small, but time it on the PG18 harness. No automatic reinterpretation of history. **Rollback:** a guarded down step that aborts if any row has a non-zero third decimal, otherwise narrows back. Update the Drizzle schema and snapshot in the same change.
8. **Known limitation (not fixed here):** historical rows carry no per-row currency; if a business changes its currency, old amounts are not re-labelled. Out of scope, recorded as a risk.

### 8.4 Tests required

- KWD `1.001`, `1.005`, `10.999` accepted and stored exactly; the same `1.005` rejected for a two-decimal currency; `1.10` stays `1.10` for USD.
- Fractional point earning, for example 3.333 at a rate of 1.50 yields 4 points (4.9995 floored); amounts that land exactly on an integer and just below it.
- Invalid precision (KWD `1.0001`, USD `1.001`), negative, zero, `NaN`, `Infinity`, exponent notation, non-numeric strings.
- Large values: `999999.999` accepted for KWD, `1000000.001` rejected, the maximum itself, and numeric(11,3) overflow.
- Budget boundary in mills (for example 3 x 0.100 against 0.300), in both the false-reject and the bypass directions that `budget-limit.ts` documents.
- Concurrency: parallel purchases with the same idempotency key produce one event; different keys produce both; the same key with a different amount stays a conflict (existing behavior preserved).
- Database round trip: read back exactly what was written, for 2- and 3-decimal values; the migration upgrade test on the throwaway PG18 harness, with a pre-existing two-decimal row preserved.
- A property test of random amounts and rates against a BigInt reference implementation.
- Regression: all existing loyalty tests pass unchanged for two-decimal currencies.

### 8.5 Open items for the owner (not invented here)

- Which currencies beyond KWD use three decimals (BHD, OMR, JOD, TND and others), if any now.
- Approval for the migration itself and its staging and production dates.
- Whether the rare one-point differences from exact arithmetic are acceptable.

### 8.6 Dependencies and remaining blocks

REWARD-02A, then REWARD-02B (stamp program, which needs the re-onboarding reference and the expiry and reset values), REWARD-03 (discount rules and stacking configuration), the overlays, UI integration, and security regression. The established order still governs: WEB-1102 certification and ACCESS-SEC-01 come first unless the owner reorders.
