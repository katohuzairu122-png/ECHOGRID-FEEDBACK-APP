# LPC-14: exact monetary precision for Kuwaiti dinar (three decimals)

Status: implemented and locally verified. **Includes migration 0108, prepared and tested on a disposable database only; NOT applied to staging or production.** No deployment, no feature activation.

## Audit of monetary representations (findings and what changed)
| Area | Before | After |
|---|---|---|
| Purchase amount in (API) | JSON number only | JSON number **or decimal text** (`"12.345"`); precision beyond the business currency's own is refused, never rounded |
| Qualifying amount, earning, thresholds, spend-based programmes | exact BigInt minor units (LPC-01), but a third decimal was **refused** because storage was `numeric(10,2)` | exact to the fils once storage is widened |
| Storage `loyalty_purchase_events.qualifying_amount`, `loyalty_transactions.purchase_amount`, `loyalty_rewards.reward_value`, `max_budget` | `numeric(10,2)` | `numeric(11,3)` (same eight whole digits, one more decimal) by **migration 0108** |
| Reward budget guard (`wouldExceedBudget`) | exact integer **cents** (would truncate a third decimal) | exact integer **thousandths** (BigInt); boundary tested at one fils |
| Reward value/budget write (`toFixed(2)`) | **silently rounded** a third decimal | exact decimal text; more decimals than the business currency allows (or than storage holds) are refused with 422 `INVALID_REWARD_AMOUNT` |
| Reward campaign dashboard (`roundMoney(count * value)`) | floating point, rounded to 2 decimals | exact integer arithmetic; the displayed number is a conversion of the exact result |
| Refunds and reversals (LPC-08) | amounts read from storage | same exact conversion (`minorFromStored`); no float |
| Qualification evidence and acquisition reader | SQL `numeric` comparison and sums | unchanged (already exact) |
| Partner credit, settlement, billing | integer minor units / bigint | no `numeric` columns elsewhere in the schema; unchanged |
| API serialization | `numeric` returned as decimal strings | unchanged (strings); stored values now carry three decimals |
| Currency formatting | `Intl` with the currency code (KWD formats with three decimals) | unchanged; amount inputs now allow `0.001` steps, the server enforces the currency's own precision |
| Promotional discounts | not implemented (see LPC-12/13) | n/a |

## Migration 0108 (prepared, not applied)
`ALTER COLUMN ... SET DATA TYPE numeric(11,3)` on the four columns. Existing values are preserved exactly (`12.50` becomes `12.500`, numerically equal); tested on legacy two-decimal rows inside a rolled-back transaction. The statements take an exclusive lock and rewrite the (small) loyalty tables while they run. Rollback script `docs/architecture/builds/TENTASHIP/rollback/0108_rollback.sql` narrows the columns back **only while no value has a third decimal** and otherwise refuses (tested).

## Safe in either deploy order
`moneyStorageScale` reads the real column scale from the catalogue (minimum across the four columns, cached for a minute). Until 0108 is applied the scale is 2 and a third decimal is refused exactly as before (PostgreSQL would otherwise round it silently on insert); after 0108 it is 3. The web accepts `0.001` steps and still sends JSON numbers, so a web build that is deployed before the API keeps working.

## Verification
API unit 292 files; 7 new KWD integration scenarios on PostgreSQL (exact 12.345 purchase, idempotent text replay, fourth decimal refused, USD refuses a third decimal, spend milestone exact at 0.999, reward value/budget three decimals for KWD and refused for USD, migration on legacy data preserving every value, rollback guard); 6 pure tests for the exact helpers and the storage probe; budget tests extended to three decimals. The migration-pin guard now treats dashes as identifiers and ranges (a false positive on "DEV-107–109" surfaced when the count reached 109).

## Before applying 0108 anywhere (Owner steps)
Restore point first; verify the staging ledger; apply through the existing migration workflow only with the Owner's explicit authorization; then deploy. No code change is needed after the migration.
