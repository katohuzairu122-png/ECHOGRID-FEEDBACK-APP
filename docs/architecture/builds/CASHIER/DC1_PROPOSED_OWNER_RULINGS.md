# D-C1 — Proposed owner rulings

**Status: RECOMMENDATIONS FOR OWNER ADOPTION. DOCUMENTATION ONLY.**
Implementation: not authorized by this document. Release: **NO-GO pending verification**. No deployment, reconciliation apply, migration or production change is authorized by these proposed rulings.

Context: D-C1 code is merged in `main` (PR #373, change record `DC1_PERMISSION_RECONCILIATION_RECORD.md`) and is not deployed or applied anywhere. The rulings below answer decisions D-C1-a to D-C1-f from that record. The first part is the owner's text as submitted on 2026-11-12; the second part records what each ruling means for the existing work.

## 1. Proposed rulings (as submitted)

**D-C1-a: staging first, then production.** Use the verified sequence: permission seed, Phase A additive, new API deployment, Phase B reduction. Require dry-run review and separate authorization at each stage.

**D-C1-b: keep custom roles until reviewed.** Do not automatically reduce or convert customized roles. Review reported grants per business and preserve explicit legitimate authorizations.

**D-C1-c: accept.** View-only roles must not automatically receive cashier service authority. Report affected roles and provide a separately reviewed correction if required.

**D-C1-d: remove both after staging verification.** Target removal of `business:view` and `branches:view` from default Staff through a separate, independently tested block. Do not change the present D-C1 reconciliation.

**D-C1-e: retire later.** Retain legacy `loyalty:manage` until all environments and relevant role grants have been reconciled. Retire through an independent compatibility block.

**D-C1-f: none needed.** Existing feedback and messaging permissions remain. Default cashier Staff must not receive them.

**Additional release conditions**

- Investigate the reported migration SQL-hash differences.
- Verify restore readiness and correct environment targets.
- Review actual role-grant dry-run evidence before changes.
- Complete staging validation before production authorization.
- Deploy the coordinated API and Web release through the approved release workflow.
- Preserve all financial activation restrictions.
- Keep CUSTOMER-AUTH-01 as a separate development workstream.

## 2. What each ruling means for the existing work

| Ruling | Effect on merged D-C1 work                                                                                      | New work implied                                                                                                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a      | The reconciliation script already runs in two dry-run-first phases with a confirmation variable. No code change | A per-stage authorization checklist (section 3) and a staging rehearsal report                                                                                                               |
| b      | Already implemented: customised roles are preserved and reported                                                | A per-business review of the dry-run list, done by you with my report                                                                                                                        |
| c      | Already implemented: roles with only `loyalty:view` do not receive `loyalty:serve` and are reported             | A separately reviewed correction only if the report shows a legitimate need                                                                                                                  |
| d      | **Not** part of the current reconciliation                                                                      | A separate block: change the Staff default, extend the reduce phase to remove both keys from unmodified Staff roles, add tests, and verify on staging that the cashier workspace still works |
| e      | `loyalty:manage` stays in the catalog and in existing grants                                                    | A later compatibility block with its own dry run, after every environment is reconciled                                                                                                      |
| f      | Already the case: default Staff holds neither feedback nor messaging keys                                       | None                                                                                                                                                                                         |

## 3. Release conditions: what each requires and its status

| Condition                                                     | Status today                                                                                                                                                                                                                                                                                                   | Needed to satisfy it                                                                                                                                                   |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Investigate migration SQL-hash differences                    | **Open.** The read-only check on 2026-11-12 found 67 applied rows matching by timestamp in each database, but only 59 (production) and 54 (staging) of 67 matching by SQL hash. The cause is not yet explained. The repository documents earlier historical hash reconciliation work, which may account for it | Your authorization for a further read-only comparison that lists which entries differ and checks them against the documented reconciliation. No change to any database |
| Verify restore readiness and correct environment targets      | **Open**                                                                                                                                                                                                                                                                                                       | Confirm Neon restore points or snapshots exist for production and staging, and confirm project, branch and database identifiers against the release inputs. Read-only  |
| Review actual role-grant dry-run evidence                     | **Open.** Only a local synthetic dry run exists                                                                                                                                                                                                                                                                | Your authorization for a read-only dry run on staging, then production, reviewed by you before any apply                                                               |
| Complete staging validation before production                 | **Open**                                                                                                                                                                                                                                                                                                       | Staging rehearsal of the full sequence with cashier, manager and owner checks                                                                                          |
| Coordinated API and Web release through the approved workflow | **Open**                                                                                                                                                                                                                                                                                                       | The existing release workflows, pinned to current `main`, with a merge freeze until approval; D-C1 phase order applies                                                 |
| Preserve financial activation restrictions                    | In force                                                                                                                                                                                                                                                                                                       | No change                                                                                                                                                              |
| CUSTOMER-AUTH-01 stays a separate workstream                  | In force                                                                                                                                                                                                                                                                                                       | Tracked in `CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md`                                                                                                              |

Environment migration `0067` is also still pending in both production and staging and belongs in the same release plan.

## 4. Required order once authorized (unchanged)

1. Permission seed (catalog contains the three new keys).
2. Phase A, additive: dry run, review, authorization, apply, on the old API.
3. Deploy the new API (and Web through the approved release workflow).
4. Phase B, reduction: dry run, review, authorization, apply.
5. Review the list of roles reported for a decision.

Each stage needs your separate authorization per environment, and a Neon restore point beforehand. Reduction before Phase A changes nothing by design; deploying the API before Phase A denies loyalty service to every role in an unreconciled business.
