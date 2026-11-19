# Staging migration-scope exception: 0080 and 0081 applied with 0082 (owner-accepted 2026-11-19)

Status: **ACCEPTED AS DOCUMENTED by the owner on 2026-11-19.** Staging only. Production was never involved.

## What happened

The CASHIER-AUTH-STAGING-01 rollout was authorised to apply migration `0082`. The staging migration workflow applies pending migrations in order, so `0080` (BDPN-F1 business public profile storage) and `0081` (B2B S9-A1 participation foundation) were applied to the same staging database (Neon project `lucky-glitter-47218268`, branch `br-bold-water-aukjlvw3`) in the same run, after the pre-migration snapshot `snap-super-meadow-auukr6e5`.

## Evidence (CASHIER-AUTH-STAGING-02 report, section 12)

- `0080`: 5 new tables, constraints and foreign keys on those new tables only, one revision guard trigger. `0081`: 2 new tables, foreign keys, indexes, guard triggers.
- Neither file contains `DROP`, `UPDATE`, `DELETE` or `INSERT`. Both are additive.
- All tables they created were empty (0 rows) after the rollout and nothing existing was modified; staging had been wiped on 2026-11-17 (snapshot `staging-pre-wipe-2026-11-17`).
- Recovery: snapshot `snap-super-meadow-auukr6e5` and a restore drill (branch `br-cold-star-au5evj0d`, retained) exist; nothing was rolled back or rewritten.

## Record of the decision

- The two migrations were **inspected as additive before they ran**, but **explicit advance authorization for `0080` and `0081` was not given**: the original scope named `0082` only. This record does not describe the earlier application as approved in advance.
- The owner reviewed the reported additive schema changes and the data-preservation evidence and **accepted the exception as documented**.
- This acceptance **does not establish permission for any future unapproved migration**. Each future migration, including `0083` (customer onboarding events), needs its own authorization naming it and the environment.
