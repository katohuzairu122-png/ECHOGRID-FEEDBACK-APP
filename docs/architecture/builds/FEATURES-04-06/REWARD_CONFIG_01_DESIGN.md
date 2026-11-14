# REWARD-CONFIG-01: primary loyalty program and type-specific settings (design only)

**Status: DESIGN ONLY. Nothing here is built, migrated, deployed or authorized. Owner review is required before any development block. Financial activation remains NO-GO. The WEB-1102 production restriction is unchanged. REWARD-02A (exact decimals and KWD) must precede any monetary reward implementation.**
Baseline: `main` `de997da6` (2026-11-14). Builds on `REWARD/REWARD_01_RECONCILIATION.md` (rulings RW-D1 to RW-D8 and the REWARD-02A specification). Labels: **VERIFIED**, **PROPOSED**, **NOT IMPLEMENTED**, **BLOCKED**, **UNKNOWN**.

## 1. Objective and scope

Each business chooses **one primary loyalty program** (LP-01 to LP-08) at registration or later, and each program has its own settings page and validation. Primary programs stay separate from **redeemable rewards** (RW-01 points, RW-02 discount, RW-03 free item, RW-04 voucher). In scope: program model, configuration schemas, states, switching, screens, dependencies. Out of scope: implementing any program, promotions and stacking beyond the default rule, financial activation.

## 2. Verified existing implementation

- **No program concept (VERIFIED).** `loyalty_settings` holds four numbers per business (`pointsPerCheckin` default 10, `pointsPerCurrencyUnit` numeric(6,2), `referralBonusPoints` default 50, `birthdayBonusPoints` default 100). There is no program type, state, version or "one active program" rule. Every business earns today under these defaults.
- **Rewards are a catalogue (VERIFIED).** `loyalty_rewards` has type (`points`, `discount`, `free_item`, `voucher`), `pointsCost`, one `rewardValue`, budget and per-day caps, limits per receipt, visit or period, start and expiry dates, branch scope, cooldown and feedback requirements.
- **Ledger (VERIFIED).** `loyalty_transactions` (types checkin, purchase, referral_bonus, birthday_bonus, adjustment, redemption), `loyalty_purchase_events` (one amount, idempotency key), tiers by `min_points`.
- **Program availability, from REWARD-01 (VERIFIED):** LP-03 and check-in points partly exist; LP-01, LP-04, LP-05, LP-06, LP-07 and LP-08 do not; item-level purchase data does not exist (RW-D3).
- **Permissions (VERIFIED):** `rewards:manage` for configuration (not held by the default Staff role); `loyalty:serve` for counter actions; settings routes require business-wide access.

## 3. Proposed target design

### 3.1 Program model (PROPOSED)

- New table `loyalty_programs`: `id`, `business_id`, `type` (`LP-01`..`LP-08`), `status` (`draft`, `active`, `inactive`, `retired`), `config` (JSON, validated by the schema of that type), `config_version`, `created_by`, `activated_by`, `activated_at`, `deactivated_at`. A partial unique index allows **at most one `active` row per business** (RW-D1).
- New table `loyalty_program_progress` for per-customer, per-program counters (stamps, streak counts, mission progress), keyed by customer, business and program. It never mixes into the points ledger.
- Every program-generated ledger or progress entry stores `program_id` and `config_version`, so history is explainable after a configuration change.
- Overlays (birthday, referral, bonus and product promotions, branch promotions) remain separate objects and do not count as primary programs.

### 3.2 Availability rule (PROPOSED)

The selector only offers a program whose build is complete and activated by the owner. Unbuilt programs appear as "Coming soon" with no select button, or are hidden. Initially available: LP-03 (spend and earn), then LP-02. LP-01, LP-04 to LP-08 stay unavailable until their blocks ship. An unimplemented program is never shown as available.

### 3.3 Configuration schemas (PROPOSED; amounts follow REWARD-02A money rules)

| Program                         | Fields                                                                                                                                 | Validation highlights                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| LP-01 Buy X, get Y free         | stamp threshold N (2 to 50), reward item name, qualifying rule (any receipt, or amount at least M), stamp expiry or none, reset policy | One stamp per verified eligible receipt (RW-D4); expiry and reset must be set before activation |
| LP-02 Fixed points per purchase | points per purchase (integer), optional minimum amount                                                                                 | Points are integers; minimum amount in business currency precision                              |
| LP-03 Spend and earn            | points per currency unit (decimal, existing column scale 2), optional check-in points, rounding rule `floor`                           | Exact decimal arithmetic (REWARD-02A); rate bounded                                             |
| LP-04 Milestones                | list of milestones: kind (visits or spend), threshold, reward reference                                                                | Ascending thresholds; each reward must exist and be active                                      |
| LP-05 Streaks                   | period (day or week), required count, grace, reset rule                                                                                | Uses the business local day (TIMEZONE-01)                                                       |
| LP-06 Off-peak                  | list of local time windows (days, start, end), bonus or multiplier                                                                     | Local times plus business timezone id (TIMEZONE-01); no overlapping windows                     |
| LP-07 Missions                  | missions: goal, progress rule, reward, expiry                                                                                          | Bounded count; expiry required                                                                  |
| LP-08 Product-specific          | product list and per-product rule                                                                                                      | **Blocked** until verified item-level purchase data exists (RW-D3)                              |

### 3.4 Relation to rewards (PROPOSED)

Programs decide how customers **earn** (points, stamps, progress). Rewards in the catalogue remain how they **redeem** (RW-01 to RW-04). Completing an LP-01 cycle creates an earned entitlement for a configured free-item reward. **UNKNOWN:** the redemption entitlement mechanism (a new entitlement record or a pre-issued redemption row) needs an owner and engineering decision before LP-01.

### 3.5 States and transitions (PROPOSED)

`draft` (editable, not applied) -> validated (server checks all fields; a preview shows an example customer journey) -> `active` (owner confirms) -> `inactive` (owner switched away or paused; history retained) -> `retired` (never reused). Editing an active program creates a new `config_version` that applies only to future events.

### 3.6 Switching and existing businesses (PROPOSED, per RW-D2)

- Only the **business owner** may activate or switch (an owner-only check on top of `rewards:manage`).
- Switching keeps all points balances, earned and unredeemed rewards and history; progress counters of the old program stay frozen and are not converted. Customers explicitly enroll in the new program under the approved re-onboarding model (**the canonical document for that model was not found in the audit; it must be cited before LP-01**).
- **Existing businesses:** each is backfilled with one `active` program that reproduces today's behavior exactly (LP-03 with the current rate and check-in points), flagged as legacy, so earning does not change on release day. They may switch later.
- **New businesses:** the registration step shows the program choices plus "Configure later". Open decision: while no program is active, customers may join but earn nothing and the owner sees a setup banner (recommended), or a default program is applied.

## 4. Data ownership and contracts

The business owns its program and rewards; customers' balances and progress are business-scoped (existing isolation, Split 03). Community Points stay separate and are never converted (RW-D8). Money fields use the REWARD-02A money module (exact decimals, KWD three decimals, no floating point, no silent conversion). Stacking default is none (RW-D5): a transaction receives the primary program's effect only unless a documented configuration says otherwise. Migration numbers must be re-verified at execution (next number after `0070`).

## 5. Authentication and authorization

Configuration, activation and switching need `rewards:manage` plus the owner check; cashiers (counter staff) can never read or change configuration (D-C1). Cashier purchase recording resolves the active program on the API at event time, so a cashier cannot choose or influence the program. Platform admin has read-only oversight.

## 6. UI and user journeys

- **Registration:** after business creation, a "Choose your loyalty program" step with one card per available program, a plain-language example, and "Configure later".
- **Loyalty, Program:** overview of the active program, status, and a switch action with an explicit confirmation that lists what stays and what does not.
- **Per-type configuration pages:** one page per program type with its own fields, inline validation, a preview, then "Activate".
- **Rewards:** the existing catalogue page, unchanged in role, with copy that distinguishes programs from rewards.
- **Customer:** the loyalty card adapts to the program (points balance, stamp row, progress), with no information about other businesses.

## 7. Security and failure handling

Idempotent events (existing idempotency keys); one stamp per receipt; progress rows updated under a row lock to stop concurrent double awards; all awards are append-only and carry `program_id` and `config_version`; activation and switching are audited with actor and previous program; a failed activation leaves the previous program active; no negative or fractional points; ratings and feedback are never an eligibility condition (RW-D6); no cross-business transfer.

## 8. Backward compatibility

The legacy backfill (section 3.6) preserves current earning. Existing reward catalogue and redemption flows keep working. No customer balance changes. The tables are additive.

## 9. Dependencies (graph)

REWARD-02A (money) -> program tables and selector shell -> LP-03 backfill of existing businesses -> LP-02 -> LP-01 (needs the re-onboarding reference and stamp expiry and reset values) -> LP-04. TIMEZONE-01 -> LP-05 and LP-06. Item-level purchase capture (RW-D3) -> LP-08. CASHIER-PWA-01 is independent but its purchase screen reads the active program. WEB-1102 certification gates any Web release; each migration needs the Gate 2 re-pin and separate authorization.

## 10. Acceptance criteria

Only one active program per business (enforced by the database); the selector never offers an unbuilt program; each program page rejects invalid configuration; legacy backfill produces identical points for a replay of recorded purchases; switching preserves balances and history; a cashier cannot reach configuration (API test per route); concurrent identical purchase events award once; KWD amounts keep three decimals through earning and display; stacking is refused unless explicitly configured.

## 11. Open owner decisions

1. "Configure later": earn nothing until a program is active, or apply a default.
2. Entitlement mechanism for LP-01 completion.
3. The re-onboarding model document for program switching, and stamp expiry and reset values.
4. Who sets business stacking configuration and the platform stacking policy text.
5. Whether the owner may run a program in draft alongside the active one for testing.
6. Terminology: the owner's phrase "reward types have their own settings" is read here as **program types** (LP) having their own settings, while reward types (RW) stay in the catalogue; confirm.

## 12. Implementation block breakdown (PROPOSED, each needs authorization)

- P0: REWARD-02A (exact decimals and KWD), already specified.
- P1: program tables, one-active constraint, program resolution service (migration).
- P2: legacy backfill and registration selector shell ("Configure later").
- P3: LP-03 configuration page and activation flow.
- P4: LP-02.
- P5: LP-01 (after decisions 2 and 3).
- P6: switching flow with owner confirmation and audit.
- P7: LP-04, then LP-05 and LP-06 after TIMEZONE-01; LP-08 after item-level capture.
