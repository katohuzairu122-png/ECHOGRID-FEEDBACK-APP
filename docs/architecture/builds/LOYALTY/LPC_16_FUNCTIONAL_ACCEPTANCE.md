# LPC-16: functional acceptance (local, synthetic)

Executed on disposable PostgreSQL 16 with synthetic customers and businesses; nothing touched staging or production.

| # | Scenario | Evidence |
|---|---|---|
| 1 | Programme configuration (invalid refused, valid draft, validate) | `loyalty-lifecycle-acceptance` test 1 |
| 2 | Only the Owner activates | same (manager refused `PROGRAM_OWNER_REQUIRED`) |
| 3 | Customer enrolment | fixtures create membership and account through the repositories used by the join flow; join consent is covered by the membership suites |
| 4 | Purchase recording | acceptance 2; KWD and idempotency in `loyalty-kwd-precision` |
| 5 | Progress calculation | acceptance 2 (stamps 2 of 3, then complete), all programme types in `loyalty-lpc-engines`, `loyalty-lp01-stamps` |
| 6 | Tier qualification | acceptance 5 (Silver at 50 points, back below after a reversal) |
| 7 | Reward entitlement | acceptance 2 |
| 8 | Cashier hand-over (once, tenant-bound) | acceptance 2 and the LP-01 race tests |
| 9 | Customer programme visibility | acceptance 2 (progress then earned reward, empty after hand-over) |
| 10 | Purchase reversal | acceptance 3 and 4 |
| 11 | Reward revocation (unused) and flag (used) | acceptance 3 and 4; interleaving probe in the security review |
| 12 | Reward catalogue protection | acceptance 2 (`REWARD_IN_USE_BY_PROGRAMME`) and `loyalty-reward-guard` |
| 13 | Unauthorized operation rejection | acceptance 6 (service boundary); API boundary in the RBAC matrix and cashier allow-list suites |

## Needs deployed staging acceptance (cannot be proved locally)
- Browser run of the Owner reversal screens and the cashier Earned rewards section against the staging build and a real cashier session (cookie and token flows).
- Customer wallet programme card on a real device and in all four languages.
- Migration 0107 (and later 0108) on a copy of real data, plus timing of the table rewrite for 0108.
- Customer registration email delivery after the Resend key change.
- Hyperdrive and runtime-role behaviour (see LPC-15).
