# NETWORK-15-T2-AR01 — proposed controlled activation runbook

**UNAPPROVED — PROPOSED, NOT EXECUTED. No instruction here authorizes an action.**
Baseline and limits: [audit](ACTIVATION_READINESS.md). Open approvals:
[owner register](OWNER_DECISIONS.md). Implementation reviewed at
`f1efc9d3f8c639dbfa1493bb58e0dee0c8335779`; main at
`aa7c016b7a3cd4aca4769414b4f18242ea2cc7fe`; #562 is unmerged.

## Before any operator action

The Owner must select the exact environment, release SHA after authorized merge,
roles/named people, customer scope, approved policy/locales and recovery plan.
Record individual approval references, approver, exact target, scope and time for
**each** state-changing step below. A confirmation phrase, passing CI, another
step's approval or this draft is never that approval. Staging approval is not
production approval. Do not put credentials, contact details or production records
in the release ticket, public PR or CI artifacts.

Execute staging first only under a future staging dispatch, review its evidence,
then obtain a separate production dispatch with separate approval references.
AR01 executes neither sequence. Stop if any earlier gate is unresolved.

## Proposed ordered sequence

| Step | Proposed action | Independent approval before any write | Evidence / stop condition |
| --- | --- | --- | --- |
| 0 | Read-only reconcile main, #562, target Worker versions, actual DB journal/hash prefix, role, flags and current publication. Inventory all pending migrations. | Read-only inspection under the future environment-specific dispatch; no credentials printed. | Stop for wrong target, changed code/hash, drift, unknown state or pending upstream migration without its owner's approval. |
| 1 | Review and merge implementation #562, only when separately authorized; pin the resulting reviewed main SHA and exact-head checks. | **A-MERGE** — human merge authority, outside AR01. | Reconcile the resulting tree, final D1, journal and CI; never deploy the PR's prospective merge SHA as if it were merged main. |
| 2 | Establish a fresh recoverable backup, access controls and approved retention; if a new snapshot is needed, create it only after approval. | **A-BACKUP**, separately per environment. | Record recovery point, scope, encryption/access owner, actual retention window, RPO/RTO and later-write handling. An old 0079 drill or provider marketing statement is insufficient. |
| 3 | Restore to a new isolated recovery target if required; rehearse recovery and the exact pending migration range, runtime rights and compatibility with approved representative data. | **A-RESTORE-DRILL** for resource/data copy; **A-REHEARSAL** for migration/privilege changes. Each requires its own reference. | No finalize, production repoint or weakened data protection. Measure locks/scans/index time and verify balances, audit guards, keys, retry/rollback and privacy reapplication. No live provider sends. |
| 4 | Apply verified route-level containment for membership Join and platform clearance during handover; preserve allowed reads/Leave where compatible. | **A-CONTAINMENT** — exact mechanism, route scope, duration, operator and tested exit/incident plan. | No dedicated membership kill flag is implemented. Feed-off and the empty terms pointer do not contain the old legacy API. Stop if an approved working mechanism is unavailable; obtain a separate engineering dispatch rather than inventing a control. |
| 5 | Apply the reviewed pending journal using the separately protected migration path, after exact target/backup recheck. | **A-MIGRATE-STAGING** or **A-MIGRATE-PRODUCTION**; approval explicitly covers every pending entry, not just the label “0088”. | `db:migrate` applies the pending journal through DATABASE_URL. Verify prefix/hashes, 0088 tables/constraints/ALWAYS triggers/index, empty current pointer and no balance/history rewrites. If 0080–0087 are pending, do not inherit their approval from T2. |
| 6 | Provision only reviewed runtime read access to the two terms authority tables and verify the actual deployed connection role; maintain separate publication authority. | **A-RUNTIME-GRANTS** — narrowly scoped privileges and executor approved separately. | Runtime cannot INSERT/UPDATE/DELETE/TRUNCATE authority. Record privilege/trigger results without secrets. No wholesale runtime-role/security cutover is authorized by AR01. |
| 7 | Deploy the pinned compatible API using the protected release path with authority still unavailable; then deploy the matching web. | **A-DEPLOY-API** and **A-DEPLOY-WEB**, distinct required approvals in the target environment. | Actual required reviewers, self-review prevention, branch restriction and environment-only credentials must first be verified. API/web are sequential, not atomic. Keep clearance contained while old clients cannot parse inactive. A typed confirmation is not approval. |
| 8 | Verify deployed identities/schema, exact release provenance, runtime role and consent-denial behavior with no approved current publication. | Read-only/isolated verification plan approved; any synthetic shared-environment data writes require a separate test-data approval. | Missing terms must not create account/consent/awards; old policyVersion-only requests fail closed. Status/Leave remain correct. Record API/web versions separately; do not use `/health` as authorization proof. |
| 9 | Approve canonical legal text, reviewed en/fr/es/ar artifacts, policy/version/effective dates, privacy/retention treatment and final hash manifest. Stage the immutable publication without making it current. | Legal/localization decisions **O1–O3** first; then **A-PUBLISH-STAGED** for the exact registry write, approving role/reference and target. | No runtime publisher endpoint exists. Use only separately reviewed privileged operator handling. Validate full exact-byte payload against the real authority before write. Approved/published rows are immutable: correct mistakes with a newly approved publication/version, never by editing history. Keep current pointer NULL. |
| 10 | Explicitly authorize G8 and select the exact approved, published, now-effective publication as current under the guarded transaction. | **A-ACTIVATE-MEMBERSHIP** — separate Owner approval for target, publication/hash/locales and pilot/rollout scope. | All G1–G7 evidence accepted. Guard requires effective dates; missing locale fails closed. In-flight shared/exclusive lock behavior must be understood. No automatic activation after deployment or legal review. |
| 11 | If a Feed change is actually required, treat it independently. | **A-FEED-CONFIG** — separate Owner approval for the existing NETWORK_FEED_ENABLED value/change. | Do not assume it is currently off/on or necessary to change. Feed permission remains active verified customer + flag + published visibility, not membership acceptance alone. No new publishing or engagement feature opens. |
| 12 | Lift previously approved handover containment only after compatibility and all acceptance gates are verified. | **A-LIFT-CONTAINMENT**, independent of activation/publication. | Confirm old workers/clients cannot reach a consent-bypass path. If targeting a limited pilot, prove an approved routing/access mechanism exists; no pilot/cohort flag is supplied by T2. |
| 13 | Permit controlled customer acceptance only within the approved rollout. Customers choose Join/Rejoin/Restore themselves. | **A-CUSTOMER-PILOT** — scope/data-handling approval; actual consent is a separate affirmative act by each eligible customer. | No support/operator fabricated consent. Validate one new membership/transition/grant, exact artifact/version, fresh Restore after clearance, no duplicate awards and unchanged business loyalty. Any live notification requires its own authorization; none is assumed. |
| 14 | Observe metrics, audit/state invariants and support readiness; expand only after the Owner accepts results. | Read-only monitoring under approved access; **A-EXPAND** for each additional rollout scope or **A-ALERT-CONFIG** for monitoring writes. | Named on-call and approved thresholds/window/SLOs are required; do not invent numbers. Record safe aggregate evidence. No automatic full rollout. |

## Conditions that stop the sequence

Unmerged/unreviewed implementation; wrong environment; unexpected existing current publication or real acceptance data outside the approved scope (never reset it on assumption); journal mismatch; unapproved
upstream migration; no fresh backup/recovery proof; unsigned legal/localization
bundle; unverified publisher/runtime separation; unsafe API/web version pairing;
no membership containment; missing protection/approver; unexpected inactive/active
pair; stale-acceptance success; duplicate event/account/award; audit guard failure;
private data in output; or an unapproved real customer/notification/provider effect.
Keep evidence restricted and escalate to the named Owner/security/operator.

## Investigation and recovery playbook — proposed only

1. **Failed customer Restore:** determine authoritative membership/account state
   and transition reference. A transaction failure must leave inactive/closed
   without new acceptance. Do not manually heal status, create a grant or edit
   an audit row. A successful activation followed by post-commit award reevaluation
   failure may already be active; retry the original scoped request only where its
   current lifecycle/publication still matches, or use a read/refresh and existing
   award recovery. Never issue replacement points as consent troubleshooting.
2. **Stale terms/lifecycle:** re-fetch the approved offer, explain that terms or
   state changed, reset to unchecked and require a new deliberate action. Never
   copy an old grant or staff-clear a voluntary Leave. Re-suspension still blocks.
3. **Dispute:** a separately authorized investigator correlates minimal customer/
   membership/transition/grant IDs, sequence, exact version/locale/artifact hash
   and timestamp with immutable evidence. Distinguish non-consent platform
   clearance from customer Restore. Record access/reason and approved retention;
   do not expose contact details, credentials or raw metadata to ordinary roles.
4. **Acceptance containment after T2 rollout:** with **A-CONTAINMENT-INCIDENT**,
   use the previously approved route mechanism and/or guarded pointer-to-NULL
   change if explicitly scoped. It blocks new T2 acceptances after the exclusive
   lock transaction completes; it does not terminate existing memberships, stop
   independent points processing, hide Feed or undo completed acceptances. Pending
   post-commit award reevaluation may finish. No pointer or flag was changed here.
5. **Compatible forward recovery:** with **A-FORWARD-FIX**, deploy a reviewed
   exact-main compatible revision through protected approvals, retaining additive
   schema, immutable publications/evidence, account IDs and legitimate later
   writes. Fixing policy content requires a newly approved immutable version and
   separately approved pointer selection, not history editing.
6. **Worker rollback:** with **A-WORKER-ROLLBACK**, first prove the chosen revision
   understands inactive, the new purpose/schema and fresh Restore. A generic
   rollback to pre-T2/legacy acceptance code is unsafe even if infrastructure
   reports it succeeded. Validate each Worker and maintain containment during
   mismatches. Do not rely on generic OPERATIONS.md rollback alone.
7. **Database recovery:** with **A-DATABASE-RECOVERY** and separately approved
   **A-CUTOVER** if needed, restore to a new isolated target, verify journal,
   evidence, balances, privilege/guard inventory and reconcile legitimate later
   writes plus completed privacy/hold decisions before any traffic change. No
   journal deletion, consent/ledger deletion, direct production restore/finalize
   or credential/Hyperdrive repoint is implied. RPO/RTO/data-loss decisions belong
   to the Owner; no values are invented here.

## Evidence package to submit before requesting G8

Approval references for each completed stage; named operators; exact main/API/web
SHAs; applied journal prefix/range; backup/restore and recovery objectives;
actual runtime role/guard results; legal publication/version/hash and all four
reviewer references; privacy/retention/support decisions; containment/reversal
rehearsal; protected environment evidence; security acceptance; monitoring/alerts;
and controlled rollout scope. Keep secrets and personal data out of the public PR.
Blank/missing evidence is a hold, never presumed approval.
