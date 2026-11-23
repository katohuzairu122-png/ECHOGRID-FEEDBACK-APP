# NETWORK-15-T2-AR02 — readiness and owner-approval package

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED.** This package is preparation,
not legal certification, a decision signature, release permission or activation.
Date: 2026-11-23 (Kuwait). Starting main:
`34925e541af993a9a75f82f0ffa7480851aaf6e0`.

## Reconciliation and precedence

- #562 merged at `740736d10ad053eadff2c8e2b0de2e78f95b5a0f` on 2026-11-23T13:28:34Z;
  reviewed implementation head `f1efc9d3f8c639dbfa1493bb58e0dee0c8335779`.
- #563 merged at `34925e541af993a9a75f82f0ffa7480851aaf6e0` on 2026-11-23T13:29:07Z;
  reviewed documentation head `cbc13ee7a74bbde97719cbdfe41227be3affb60d`.
- Main differs from the reviewed implementation head only by AR01's four Markdown
  files. No runtime changes were imported from an unfinished parallel workstream.
- [AR01](../AR01/ACTIVATION_READINESS.md) is preserved as a dated historical audit;
  its unmerged-implementation/G1 hold is now **SUPERSEDED**. Its legal, containment,
  target and operational holds are not resolved by merging.
- [Final D1](../NETWORK_15_T2_D1_APPROVED.md) remains approved for development:
  **every Restore needs fresh customer consent**. Platform clearance is inactive,
  never customer acceptance. Prior-consent reuse remains superseded.
- D2's exact wrapped-error/concurrency correction is merged through #553; no D2
  production code, privacy policy or historical migration is changed here.
- The existing journal ends at 0088. Shared target journals, deployed versions,
  current publication, live flags, runtime privileges and protections remain
  **NOT VERIFIED**. No approved legal publication/version/effective date is seeded.

## Current requirement and gate matrix

| Requirement                                                             | Classification / evidence                                                                                |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Strict explicit Join/Rejoin/fresh Restore and atomic proof              | IMPLEMENTED; VERIFIED in merged source, exact-head CI and fresh AR02 PG16/18 checks.                     |
| Idempotency, customer/account locks, stale publication/lifecycle denial | IMPLEMENTED; VERIFIED, including six-way requests and Restore/Leave rollback/races.                      |
| Retained audit, no fabricated legacy consent, separate accounting       | IMPLEMENTED; VERIFIED. Ten synthetic pre-upgrade table fingerprints preserved on both PG majors.         |
| Four-language UI, unchecked consent, version/locale/hash metadata       | IMPLEMENTED; VERIFIED technically. Legal terminology/equivalence professionally UNAPPROVED.              |
| Approved Community terms, legal versions and four legal artifacts       | UNAPPROVED; BLOCKED. Prepared material is not a publication.                                             |
| 0088 target/pending-range/role/backup approval                          | PARTIALLY VERIFIED: source and isolated upgrade verified; live target and approval BLOCKED.              |
| Independent Join/Rejoin/Restore/clearance containment                   | BLOCKED: no dedicated controls found; [CONTROL-01](NETWORK_15_T2_CONTROL_01.md) is a specification only. |
| Support, disputes, monitoring, retention and named operators            | PARTIALLY VERIFIED generic infrastructure; proposed procedures UNAPPROVED.                               |
| Protected release and activation                                        | BLOCKED; environment enforcement and explicit approval NOT VERIFIED.                                     |

| Gate                                      | Result  | Objective basis / remaining prerequisite                                                                                                                                                               |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1 Implementation verified and merged     | PASS    | #562 is merged; runtime source matches tested f1efc9d and fresh isolated checks.                                                                                                                       |
| G2 Migration approved and target verified | BLOCKED | Actual pending range, privileges, recovery, lock budget and environment-specific approval missing.                                                                                                     |
| G3 Legal documents approved               | BLOCKED | Draft package only; qualified approval/reference/version/date absent.                                                                                                                                  |
| G4 Legal translations approved            | BLOCKED | en/fr/es/ar legal reviewer approvals and final artifacts absent.                                                                                                                                       |
| G5 Runtime and security controls verified | BLOCKED | Implementation invariants pass, but adequate containment is not implemented/proven and live configuration is NOT VERIFIED. AR01's narrower implementation-only PASS is not full runtime certification. |
| G6 Operations approved                    | BLOCKED | Roles, thresholds, investigation, retention and incident/recovery procedures remain proposals.                                                                                                         |
| G7 Protected deployment authorized        | BLOCKED | Workflow source exists; effective settings/credentials and target-specific deployment authority NOT VERIFIED.                                                                                          |
| G8 Separate activation authorization      | BLOCKED | AR02 explicitly does not grant it.                                                                                                                                                                     |

## Exact AR01-to-AR02 decision crosswalk

The authoritative [AR01 O1–O10 register](../AR01/OWNER_DECISIONS.md) is not renamed
or rewritten. AR02 dispatch labels are a presentation layer, not newly approved
historical decisions. In particular, D04 cannot replace O4's legacy/material-change
scope with versioning alone; D08 also retains O8's backup objectives and ownership.

| AR02 | Preserved AR01 item                                  | Extension requested by this dispatch                                                                              |
| ---- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| D01  | O1 Canonical membership policy                       | Review-ready Join/Rejoin/Restore terms and consent drafts.                                                        |
| D02  | O2 Four-language legal artifacts                     | Exact translation acceptance matrix.                                                                              |
| D03  | O3 Privacy, retention, withdrawal and recovery       | Field-level governance and decision record.                                                                       |
| D04  | O4 Policy changes and legacy members                 | Version/effective publication process also draws on O1/O5; O4's materiality, notices and legacy decisions remain. |
| D05  | O5 Publication authority and incident control        | Approval/publisher separation, supersession/withdrawal and evidence requirements.                                 |
| D06  | O6 Database/release target and pending chain         | Exact runner behavior, preconditions and verification SQL.                                                        |
| D07  | O7 Handover containment and client compatibility     | Proposed bounded CONTROL-01; no implementation.                                                                   |
| D08  | O8 Backup/recovery objectives and ownership          | Seven failure/dispute recovery cases; O7/O9 coordination retained.                                                |
| D09  | O9 Support, dispute, monitoring and incident SOP     | Role placeholders and operating/recovery draft.                                                                   |
| D10  | O10 Protected release and explicit rollout authority | Separate migration, deployment, publication and activation approval checkpoints.                                  |

## Ten approval-ready records

All records below are **UNAPPROVED**. No approver, assignee, approval reference,
legal version/effective date, retention period, RPO/RTO or SLO is filled in.

### D01 / O1 — Community terms

**Issue/requirement:** actual independent Community membership needs accessible
approved terms for initial Join, terminated-membership Rejoin and fresh Restore.
[Legal review draft](LEGAL_REVIEW_DRAFT.md) reconciles the existing T1 draft with
final D1, without modifying published `/terms` or `/privacy`.
**Options:** A approve a reviewed consolidated policy and exact artifacts; B return
specific clauses for revision; C hold enrollment. **Recommend:** A only after legal
review, otherwise C. **Consequences:** accepting unreviewed text or borrowing the
registration/business version would be false governance; no new benefits/rights
are inferred. **Authority:** Owner + appointed qualified legal/policy reviewer.
**Evidence:** final redline, feature/consent-purpose mapping, jurisdiction/contact/
eligibility decisions, approved version/dates and approval reference. **Status:** UNAPPROVED.

### D02 / O2 — localization

**Issue/requirement:** four UI locales are not four approved legal artifacts.
**Options:** A reviewed en/fr/es/ar bundle; B postpone rollout until missing reviews
are complete. Do not silently add an English fallback. **Recommend:** A only with
recorded legal/native review. **Consequences:** mistranslated consent or altered
termination/points language undermines the approved canonical meaning. **Authority:**
Owner + named native-language and legal reviewers. **Evidence:** [matrix](LOCALIZATION_REVIEW.md),
reviewers/revisions, term glossary, semantic approval and frozen UTF-8 hashes.
**Status:** UI technically VERIFIED; legal artifacts UNAPPROVED.

### D03 / O3 — privacy, retention and withdrawal

**Issue/requirement:** immutable proof remains linkable through retained account
IDs and must fit the existing anonymization/hold architecture. **Options:** A
approve purpose-based treatment and restricted access using existing preservation;
B request a separately scoped amendment where policy cannot fit; C hold.
**Recommend:** A only after privacy/legal review, never an invented purge period.
**Consequences:** withdrawal is not erasure; raw customer deletion could cascade
mutable projections while audit remains; do not introduce that operation.
**Authority:** privacy/legal owner with existing D2 owner. **Evidence:** the
[data-governance draft](LEGAL_REVIEW_DRAFT.md#data-governance-decision-record),
purpose/legal basis/criteria/holds, access/dispute and recovery reapplication plan.
**Status:** UNAPPROVED; no retention behavior changed.

### D04 / O4 — versioning, effective publication and legacy members

**Issue/requirement:** immutable versions must identify exact approved text, while
material changes/legacy effects remain separately undecided. **Options:** A retain
no fabricated backfill/no new legacy gate and publish immutable versions under an
approved change policy; B commission an explicit reacceptance amendment; C hold
new publications. **Recommend:** A with explicit legal decisions; do not infer B.
**Consequences:** changed content cannot reuse a version; a new policy pointer does
not itself suspend existing members, erase balances or change Feed eligibility.
**Authority:** product + legal/privacy owners. **Evidence:** materiality/notice/
nonacceptance/legacy ruling, canonical version, approval/publication/effective
ordering, artifact/manifest mapping and a supersession plan. **Status:** UNAPPROVED.

### D05 / O5 — publisher authority

**Issue/requirement:** runtime authority tables are SELECT-only; no publishing API
or legal-approver application permission exists. **Options:** A approve a named,
reviewed privileged-operator process with separate policy approver/publisher and
mandatory immutable change evidence; B commission a publisher tool in a separate
dispatch; C keep authority unavailable. **Recommend:** A only if its transaction,
identity and audit procedure are demonstrated; otherwise C/B. **Consequences:**
platform `community:adjust` and official-post two-reviewer powers are not legal
publication authority. **Authority:** Owner + legal + database/security owners.
**Evidence:** named responsibility/separation matrix, reviewed payload, restricted
executor, approval reference and before/after pointer/version audit design. Approved
rows are not edited to mark superseded: select a different approved pointer;
withdraw current availability by an approved NULL pointer, preserving history.
**Status:** UNAPPROVED; no permissions granted or policy writes performed.

### D06 / O6 — migration scope

**Issue/requirement:** the runner can apply more than 0088; timestamp-only completion
checks do not establish an exact prefix. **Options:** A approve a verified complete
pending range after isolated rehearsal and owner coordination; B stop on mismatch
or missing upstream approval. **Recommend:** A only with all evidence. **Consequences:**
wrong target/prefix can apply unrelated security/privacy changes or skip gaps.
**Authority:** Owner and each affected migration/runtime owner. **Evidence:**
[checklist and read-only SQL](MIGRATION_RELEASE_CHECKLIST.md), target journal,
reviewed hash exceptions, backup/lock budgets, isolated results and narrow grants.
**Status:** isolated compatibility VERIFIED; shared scope/approval BLOCKED.

### D07 / O7 — containment

**Issue/requirement:** Feed-off is not independent membership containment; old code
and mixed API/web clients need a safe handover. **Options:** A separately authorize
[CONTROL-01](NETWORK_15_T2_CONTROL_01.md); B demonstrate already-approved external
route containment with equivalent independent behavior; C hold activation.
**Recommend:** A, retaining C until implemented/proven; no control is added here.
**Consequences:** current-pointer NULL blocks T2 customer acceptances but not
platform clearance, old code, existing members or independent points/Feed activity.
**Authority:** Owner + release/security/product owners. **Evidence:** default-off
boundaries, rollout/propagation/drain proof, negative/concurrency tests and recovery
compatibility. **Status:** proposed development NOT AUTHORIZED; activation BLOCKED.

### D08 / O8 — recovery

**Issue/requirement:** a historical 0079 drill does not certify 0088 or recovery of
later consent/privacy decisions. **Options:** A approve measured current recovery
objectives, fresh backup, isolated rehearsal and compatible forward recovery; B
hold. **Recommend:** A before release. **Consequences:** pre-T2 rollback can bypass
consent or fail to parse inactive; destructive restore can lose legitimate later
writes and revive erased linkage. **Authority:** Owner + recovery/privacy/security
operators. **Evidence:** [scenario playbook](OPERATING_RECOVERY_MODEL.md), RPO/RTO,
backup identity/access/retention/cost, restore and cutover approvers, later-write/
erasure reconciliation. **Status:** UNAPPROVED; objectives and names unresolved.

### D09 / O9 — operations

**Issue/requirement:** consent/transition failures need observability, support and
restricted investigation without editing proof or issuing substitute points.
**Options:** A approve the proposed role/SOP/signal matrix with named people and
measured thresholds; B return gaps/hold. **Recommend:** A only after rehearsal.
**Consequences:** generic health/queue logs do not detect every consent failure;
indefinite or publicly exported evidence is not an approved retention plan.
**Authority:** Owner + support/security/on-call/privacy leads. **Evidence:**
[operating model](OPERATING_RECOVERY_MODEL.md), destinations/access, threshold and
escalation decisions, support rehearsal and dispute evidence handling. **Status:** UNAPPROVED.

### D10 / O10 — protected release and activation

**Issue/requirement:** merge, migrations, deployment, staged publication and making
terms current are separate acts. **Options:** A environment-specific approvals
under G1–G8 after accepted evidence; B hold. **Recommend:** A only after all prior
holds close. **Consequences:** a typed workflow confirmation or green CI is not
approval; no pilot/cohort control is supplied by T2. **Authority:** Owner + named
independent release/security approvers. **Evidence:** exact main/API/web SHAs,
actual protection/credential isolation, target/grants, legal/localized artifacts,
containment/recovery/monitoring and separate activation/customer-scope approvals.
**Status:** UNAPPROVED; no release or activation is authorized by AR02.

## Approval record format

For each D-ID/O-ID: selected option and exact scope; named approver/executor and
separation; authoritative artifact revision/hash; evidence links; approval
reference/time; target and permitted action; prerequisites; unresolved exceptions;
and withdrawal/review conditions where decided. Blank is not approval.
Do not automatically start CONTROL-01, T3 or another workstream from these options.

## Package map and evidence

- [Legal materials and data governance](LEGAL_REVIEW_DRAFT.md)
- [Four-language acceptance](LOCALIZATION_REVIEW.md)
- [Migration/protected-release checklist and read-only SQL](MIGRATION_RELEASE_CHECKLIST.md)
- [Proposed CONTROL-01](NETWORK_15_T2_CONTROL_01.md)
- [Operating/recovery draft](OPERATING_RECOVERY_MODEL.md)
- [Executed isolated validation](VALIDATION_EVIDENCE.md)

AR01's commit-pinned source/CI catalog and protected runbook are reused, not copied
or retrospectively approved. Current source: Community membership/terms/persistence/
platform-state services, customer and platform routes, shared schemas, 0088/journal,
`verify-production-migrations.mjs`, `drizzle.config.ts`, runtime role manifest,
legal pages, en/fr/es/ar messages, `OPERATIONS.md`, privacy/D2 records and release
workflows at the baseline above. AR02 changes documentation only.
