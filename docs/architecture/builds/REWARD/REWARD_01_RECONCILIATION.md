# REWARD-01: loyalty and reward reconciliation (audit only)

**Status: AUDIT RECORD. Documentation only. No code, schema, migration, deployment or Cloudflare change. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged.**
Baseline: `main` `3ec57a01` (2026-11-13). Open PR at audit time: #411 (impersonation gate, unrelated to loyalty). Labels: **VERIFIED** (read in source), **NOT AUDITED** (not read in this block), **PROPOSED**.

## 1. What was inspected (VERIFIED)
`apps/api/src/db/schema/loyalty-settings.ts`, `loyalty-rewards.ts`, `loyalty-transactions.ts`, `loyalty-purchase-events.ts`, `loyalty-tiers.ts`; `apps/api/src/loyalty/*` (account, reward, redemption, tier services and routes); the web loyalty pages under `apps/web/src/app/dashboard/loyalty/` (scan, redeem, rewards, tiers, settings); the shared reward types; `ECHO_GRID_SPLIT_03_LOYALTY_QR_CORE_v1.0.md`. Not read in depth: Split 06 and 07 internals, customer-side loyalty pages, the database triggers.

## 2. Existing model (VERIFIED)
Membership, then loyalty account, then qualifying event, then ledger entry, then projection (Split 03 frozen model). Per business `loyalty_settings` holds four numbers only: `pointsPerCheckin`, `pointsPerCurrencyUnit`, `referralBonusPoints`, `birthdayBonusPoints`. There is **no program-type field**, so no "one active primary program" concept exists. Ledger types found: checkin, purchase, referral_bonus, birthday_bonus, adjustment, plus redemption rows. Purchases are stored as events with one amount and an idempotency key; there is no item or product detail.

## 3. Reconciliation matrix

### 3.1 Primary programs
| ID | Program | Classification | Evidence |
| -- | ------- | -------------- | -------- |
| LP-01 | Buy X, get Y free | **NOT IMPLEMENTED** | No stamp or purchase counter, no X/Y fields. |
| LP-02 | Fixed points per purchase | **PARTIALLY IMPLEMENTED** | Fixed points exist per check-in (`pointsPerCheckin`); no fixed award per purchase. |
| LP-03 | Spend-and-earn points | **PARTIALLY IMPLEMENTED** | Purchase earns `floor(amount x pointsPerCurrencyUnit)`. Precision caveats in section 4. |
| LP-04 | Milestone rewards | **PARTIALLY IMPLEMENTED** | Tiers exist (`min_points`, free-text `benefits`). No transaction-count or spend milestones, no automatic unlock. |
| LP-05 | Streak rewards | **NOT IMPLEMENTED** | No streak state or reset rules. |
| LP-06 | Off-peak rewards | **NOT IMPLEMENTED** | No time-window rule. |
| LP-07 | Mission / challenge | **NOT IMPLEMENTED** | No challenge model. |
| LP-08 | Product-specific loyalty | **NOT IMPLEMENTED; BLOCKED BY OWNER DECISION** | Purchases carry no item data; needs a product-capture decision. |
| n/a | One active primary program per business, switching rules | **NOT IMPLEMENTED; BLOCKED BY OWNER DECISION** | No program selector exists; switching and re-onboarding rules are not decided. |

### 3.2 Reward types
Reward `type` is limited by a database check to `points`, `discount`, `free_item`, `voucher`. Rewards have `pointsCost`, one `rewardValue` (numeric 10,2), `maxBudget`, per-day cap, `limitPer` (receipt, visit, period), start and expiry dates, branch scope, cooldown, feedback-minimum fields and an optional visit-verification flag.
| ID | Type | Classification | Notes |
| -- | ---- | -------------- | ----- |
| RW-01 | Points | **FULLY IMPLEMENTED (core)** | Cost, redemption code, staff confirmation, limits. Deep lifecycle tests NOT AUDITED. |
| RW-02 | Discounts | **PARTIALLY IMPLEMENTED** | One `rewardValue`; no percent-versus-fixed unit field, no minimum-spend, no cap other than `maxBudget`. |
| RW-03 | Free items | **PARTIALLY IMPLEMENTED** | Type exists; no product link and no stamp count (so "buy 4, get the 5th free" is not expressible). |
| RW-04 | Vouchers | **PARTIALLY IMPLEMENTED** | Type and unique `redemptionCode` per redemption exist; a separate voucher entity with its own expiry and single-use state was not found. NOT AUDITED in depth. |

### 3.3 Promotional overlays
| Overlay | Classification | Evidence |
| ------- | -------------- | -------- |
| Birthday / anniversary | **DATA ONLY** | `birthdayBonusPoints` setting and a `birthday_bonus` ledger type exist; no award path was found. |
| Bonus earning promotions | **NOT IMPLEMENTED** | No campaign multiplier. |
| Product promotions | **NOT IMPLEMENTED; BLOCKED BY OWNER DECISION** | Needs item data. |
| Referral rewards | **PARTIALLY IMPLEMENTED** | `referralBonusPoints` is awarded at enrollment when a referrer exists; attribution and abuse rules are not documented. |
| Branch-specific promotions | **PARTIALLY IMPLEMENTED** | Rewards carry `branchId` and start/expiry dates; no campaign object. |

### 3.4 Other areas
| Area | Classification | Notes |
| ---- | -------------- | ----- |
| Community Points boundary | **NOT AUDITED in this block** | Splits 06 and 07 documents exist (orphan settlement, consumption evidence); no cross-ledger conversion was looked for or built. |
| Business dashboard | **PARTIALLY IMPLEMENTED** | Pages for scan, redeem, rewards, tiers, settings exist. Program selection and campaign pages do not. |
| Cashier "Serve customers" | **IMPLEMENTED (not re-audited)** | D-C1 permissions unchanged. |
| Customer view | **NOT AUDITED** | Customer pages not read here. |
| Reversal and recovery | **PARTIALLY IMPLEMENTED** | Corrections use `adjustment` entries (compensating, append-only). No reversal for a redemption was found in the loyalty services. NOT AUDITED in Split 07. |
| "Split 08 loyalty isolation" | **NOT VERIFIED** | The name could not be matched to a document; `SPLIT-08` holds CE1 and DEV gate documents. Owner to confirm which specification is meant. |

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
- Which specification "Split 08 loyalty isolation" refers to.

## 6. Proposed next blocks (PROPOSED; each needs authorization; none started)
- **REWARD-02A:** exact-decimal money handling and 3-decimal support (schema plus service), no behavior change for 2-decimal currencies. Needs migration authorization.
- **REWARD-02B:** stamp program (LP-01) behind a per-business setting, after the stamp rules above are decided.
- **REWARD-03:** discount rule fields (percent or fixed, minimum spend, cap).
- Then overlays, then UI, then security regression, per the directive. The established roadmap order governs: WEB-1102, ACCESS-SEC-01 and the access-model blocks come first unless the owner reorders.
