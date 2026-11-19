# CASHIER-PROD-RELEASE-P2R, Part A: isolated snapshot restore drill record (2026-11-19)

Status: **RESTORE DRILL PASSED. Snapshot recovery verified in an isolated branch. Not a disaster-recovery cutover: nothing was finalized, promoted or repointed.** Baseline: `main` @ `91aa915`. Production untouched.

## 1. What was restored, and the isolation gate

- Project `divine-voice-54333763` ("echo-grid-production"); source branch `br-blue-paper-atrcoge1` (default, primary, protected); compute `ep-gentle-queen-at8muqyy`; production Hyperdrive `echo-grid-feedback-db` origin = that compute (re-read before and after).
- Snapshot `snap-dawn-poetry-atr06u8j` ("echo-grid-prod-pre-cashier-0080-0083-2026-11-19"), created 2026-11-19T15:47:32Z, manual, no expiry, full_size 44,122,112 bytes, source `br-blue-paper-atrcoge1`.
- Isolation gate (Neon documentation, "Restore from a snapshot > Multi-step restore", read 2026-11-19): a restore with `finalize` false "creates a new branch with the snapshot data" and "your current branch will remain unchanged"; only `finalize` (one-step) or the separate finalize call moves computes, renames branches and moves protection. The tool's `finalize` defaults to false and was passed explicitly as false. No `target_branch_id` was supplied. The branch name was unused (checked against the branch list).

## 2. Operation result

| Item | Value |
|---|---|
| New branch id | `br-weathered-darkness-at2uoiy3` |
| Name | `cashier-p2r-restore-verification-2026-11-19` |
| Created | 2026-11-19T16:26:30Z, ready at 16:26:31Z |
| `restore_status` | `restored` (not `finalized`) |
| `restored_from` | `snap-dawn-poetry-atr06u8j` |
| parent LSN | `0/108A4ED0` (the exact LSN recorded in the P2 baseline), parent timestamp 2026-11-19T15:47:11Z |
| Flags | primary false, default false, protected false |
| Compute | `ep-fragrant-boat-at5ym4ui`, read_write, 0.25 to 8 CU autoscaling, **`suspend_timeout_seconds` 0 (it does not auto-suspend)**, created 16:26:30Z, separate from production |
| Warnings | none returned |
| Note | the branch record carries `restored_as: br-blue-paper-atrcoge1`, which is the intended target of a possible *later* finalize. **Do not run `finalize_branch_restore` on this branch** |

## 3. Restored database versus the snapshot-time baseline (read-only SQL, same queries as P2)

| Check | Baseline (P2, 15:47:25Z) | Recovered branch (16:27:00Z) | Result |
|---|---|---|---|
| PostgreSQL | 18.7 | 18.7, not in recovery | PASS |
| Migration ledger | 80, last 1794826876090 (0079) | 80, last 1794826876090 (0079) | PASS |
| Pending objects (0080-0083 tables, managed columns) | none | none | PASS |
| Public tables | n/a | 110 | recorded |
| Businesses / users / active users | 1 / 1 / 1 | 1 / 1 / 1 | PASS |
| Roles / permissions / role-permission grants | 4 / 34 / 92 | 4 / 34 / 92 | PASS |
| Branches active / total | 0 / 2 | 0 / 2 | PASS |
| Active user-business grants | 1 | 1 | PASS |
| Customers / memberships / loyalty accounts / loyalty transactions | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 | PASS |
| Audit rows / latest | 114 / 2026-11-19T15:00:52Z | 114 / 2026-11-19T15:00:52Z | PASS |
| Identifier fingerprint (md5 of sorted business, user, role, permission ids, same query as P2) | `9759048ecbdb62ed270943748d32a221` | `9759048ecbdb62ed270943748d32a221` | **PASS (identical)** |
| Role-grant fingerprint (same query as P2) | `3eb4cd83b75ee0e29839ba5496656751` | `3eb4cd83b75ee0e29839ba5496656751` | **PASS (identical)** |

## 4. Production non-interference (re-read after the restore)

| Check | Result |
|---|---|
| Branch `br-blue-paper-atrcoge1` | still `production`, primary, default, **protected**, ready; same logical size 44,122,112 bytes; `restore_status` absent |
| Production compute | still `ep-gentle-queen-at8muqyy`, binding `cx4`, same `started_at` (2026-11-17T20:56:02Z); not restarted, not moved |
| Hyperdrive `echo-grid-feedback-db` | origin unchanged (`ep-gentle-queen-at8muqyy...`), `modified_on` 2026-11-13 unchanged |
| Hyperdrive staging | unchanged |
| Recovery compute | a separate endpoint on the recovery branch only; no Worker or Hyperdrive references it |
| Snapshot | unchanged and still listed; no other snapshot created |
| Other branches | unchanged (one protected rehearsal copy, three archived) |
| Application deployment | unchanged (no deployment performed) |
| Production data | not written by this operation (restore reads the snapshot and writes only the new branch) |

PASS. The only production-side counters that moved (`updated_at`, active time) are ordinary live activity.

## 5. Verdict and limits

**PASS:** the snapshot restores into an isolated, non-default branch whose ledger, schema, counts and both fingerprints equal the snapshot-time baseline. Recovery from this snapshot is demonstrated.
**Not demonstrated, not authorized:** a production cutover (finalize, compute swap, Hyperdrive repoint), application behaviour against the recovered data, and the time a real cutover takes. Writes made to production after 2026-11-19T15:47:32Z are not in the snapshot.

## 6. Recovery branch retention

- Preserved for Owner review; **not deleted**, **not finalized**, **not suspended** by this block.
- Cost: a 0.25 CU minimum compute that does not auto-suspend runs continuously; at Neon's published launch-plan compute rate this is on the order of a few tens of US dollars per month (rate not verified here: check the Neon billing page), plus branch storage for 44 MB (the snapshot itself is billed at US$0.09 per GB-month per the Neon documentation). Branch storage is small; the compute is the cost.
- Suspension is supported (suspend the branch's endpoint, or set a suspend timeout on it). It needs your approval because this block did not authorize changing the recovery compute.
- Cleanup, only with the Owner's approval: confirm the branch is no longer needed as a rehearsal source (for the D2 follow-up migration rehearsal it is useful), suspend or delete the recovery endpoint, then delete the branch; never delete the snapshot or any production branch. Neon documents that deleted branches are recoverable only within its retention window.

## 7. If a real recovery were ever needed (documentation only, not performed)

1. Stop writes or accept loss of writes after the snapshot; export any legitimate later data from the live branch first.
2. Prefer application rollback (redeploy the previous Worker revision) when the data is intact; it changes no data.
3. Restore into a new branch (multi-step), verify with the queries in section 3, then, only with explicit approval, finalize (Neon moves the original branch's computes onto the restored branch, renames the original to `<name> (old)`, moves protection and the backup schedule). The connection string and Hyperdrive origin then stay the same; no application change is needed.
4. If finalize is not used, repoint the production Hyperdrive config to the recovered endpoint (an Owner action) and later restore the original origin; keep the original branch for audit.
5. Record snapshot ids, branch ids, timestamps and approvers in the release log.
