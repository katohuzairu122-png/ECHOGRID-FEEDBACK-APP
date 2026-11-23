# Community operating, support and recovery model

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED. No named assignment, threshold,
alert destination or operational action is authorized here.** Uses
[AR01's protected runbook](../AR01/CONTROLLED_ACTIVATION_RUNBOOK.md),
[AR02 decisions](READINESS_AND_OWNER_DECISIONS.md) and the
[migration/release checklist](MIGRATION_RELEASE_CHECKLIST.md).

## Responsibility and separation matrix — placeholders only

| Responsibility                                      | Proposed role placeholder         | Decision/evidence; current status                                                                                    |
| --------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Release/accountable product owner                   | [OWNER TO ASSIGN]                 | Accept G1–G7; separately authorize G8 and customer scope; UNASSIGNED.                                                |
| Technical release operator                          | [RELEASE OPERATOR TO ASSIGN]      | Execute only pinned protected API/web action; cannot self-grant legal/activation approval.                           |
| Legal/policy approver                               | [QUALIFIED REVIEWER TO ASSIGN]    | Approve policy/jurisdiction/notice/version and processing treatment; no technical staff approval inferred.           |
| Native-language reviewer                            | [EN/FR/ES/AR REVIEWERS TO ASSIGN] | Exact semantic/artifact review with legal owner; no automated certification.                                         |
| Security reviewer                                   | [SECURITY REVIEWER TO ASSIGN]     | Actual role/containment/protection/negative-test acceptance; independent of executor where approved policy requires. |
| Customer support owner                              | [SUPPORT OWNER TO ASSIGN]         | Approved request channel, retry/dispute wording and escalation; no unilateral points/consent repair.                 |
| Incident responder                                  | [INCIDENT LEAD TO ASSIGN]         | Severity/containment authority, evidence handling and safe escalation; no preapproved flag/secret changes assumed.   |
| Database migration operator                         | [DB OPERATOR TO ASSIGN]           | Exact target/pending range, backup, migration and narrow grants only under separate approval.                        |
| Policy publisher / investigator / recovery operator | [SEPARATE ASSIGNMENTS TO APPROVE] | Restricted executor and evidence access; different approval responsibilities documented before action.               |

Current `RELEASE-OWNERSHIP.md` role labels do not establish these named assignments.
D05 recommends separate legal approval and publishing/technical execution, but no
new platform permission or database grant is made. Name escalation deputies and
coverage only when the Owner approves; do not invent personnel or response times.

## Proposed monitoring and failure signals

Generic Worker logs, health and queue/cron alerts exist in source. None proves
Community-specific thresholds, destinations, live coverage or on-call response.

| Required signal                | Detection/evidence proposal                                                                                                 | Action under approved SOP                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Consent persistence failure    | Safe fixed failure code + atomic state/evidence check; separate pre-commit failure from post-commit award failure           | Do not insert a replacement grant or assume the request never committed.                       |
| Unexpected activation          | New active state without matching affirmative transition/current basis, or staff clearance resulting active                 | Contain through verified approved mechanism, preserve evidence, escalate security.             |
| Duplicate transition attempts  | Scoped replay/conflict rates, duplicate-key/invariant errors; distinguish normal retries                                    | Verify exactly one acceptance/account/award; do not delete duplicates as an improvised repair. |
| Restore failure                | Status/account pairing, clearance barrier and customer Restore correlation                                                  | Explain inactive vs suspended; no prior grant reuse or support self-reactivation.              |
| Authorization denial           | Bounded session/phone/role/operation denial categories                                                                      | Check actual authorization; do not turn verification into consent or broaden roles.            |
| Migration error                | Reviewed journal identity/range, failed statement/index/guard and target identity                                           | Stop release, inspect ambiguous outcome read-only, follow approved recovery.                   |
| Policy mismatch/unavailability | Expected publication/locale/hash/version vs real authority; distinguish intentional empty state from post-activation outage | Re-fetch authoritative offer; reaccept explicitly after resolved stale state.                  |
| Cross-customer/tenant anomaly  | Approved scoped access/invariant evidence with safe identifiers under restricted investigation                              | Escalate immediately under assigned severity; no public/raw metadata export.                   |

Thresholds, severity, aggregation/cardinality, retention, destinations, observation
window and escalation targets: **UNRESOLVED**. Do not put phones, emails, credentials,
raw requests/consent metadata or sensitive identifiers into metrics/public CI.
Any live monitoring/alert configuration needs a separate approval. Rejected-action
telemetry is not a successful consent event or mandatory acceptance proof.

## Support, dispute and retention procedure drafts

1. **Intake:** use the approved channel [UNRESOLVED], verify requester via existing
   authoritative identity procedures, record a restricted case reference and scope.
   An unauthenticated message alone never authorizes record disclosure or mutation.
2. **Status/retry:** read current membership/account/transition. Unavailable is not
   absent/zero points. For stale terms/basis, refresh and require unchecked fresh
   acceptance; never copy a prior grant, set verified flags or force a status.
3. **Dispute investigation:** separately authorize the investigator and case scope;
   compare exact publication/version/locale/content hash, server time, grant,
   sequence and previous basis. Distinguish moderator clearance (`consentAccepted:false`)
   from customer Restore (`true`). Minimize access; database SELECT privileges do
   not themselves establish case authorization. Record approved access/reason.
4. **Withdrawal/retention:** use existing owned withdrawal/Leave where allowed;
   suspended self-service restrictions stay. Route erasure/hold/legal questions to
   the approved privacy owner. Do not promise universal deletion, invent a period,
   alter immutable proof or use raw customer-row deletion/cascades as a shortcut.
5. **Resolution:** communicate only after an approved support response and customer
   identity/scope check. No live communication is sent by AR02; no SLA is invented.
   Close the case under approved evidence retention, or escalate to the named
   incident/security/legal owner. Support cannot approve terms or issue substitute
   points to hide a consent failure.

## Recovery scenarios — proposals, not execution authority

| Scenario                                     | Safe assessment and proposed recovery                                                                                                                                                                                               | Separate authority / stop                                                                                                                |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Failed migration                             | Re-read journal/schema/index/guards and pre/post evidence; connection loss may have committed. Preserve data and existing applied prefix; use reviewed compatible forward repair.                                                   | Migration owner + backup/incident plan; no fake journal entries, down-script improvisation or shared rerun without approval.             |
| API deployed, web incomplete                 | Maintain approved route containment; identify each exact deployed SHA and inactive/contract compatibility; finish same reviewed release or compatible forward fix.                                                                  | Distinct protected deployment approvals; pre-T2 rollback is not presumed safe.                                                           |
| Wrong policy/publication                     | Keep historical approved row immutable. Under separately approved containment, withdraw current availability or select a newly approved correct publication; investigate any real acceptances.                                      | Owner/legal/publisher approval for every pointer/row write; no retrospective approval or audit rewrite.                                  |
| Customer consent dispute                     | Restricted case investigation with exact artifact and transition chain; preserve proof and approved privacy handling, explain accepted vs cleared state.                                                                            | Approved investigator/support/legal process; no raw export, invented consent or points compensation by default.                          |
| Incorrect membership transition              | Contain new relevant operations only using verified approved controls; investigate state/evidence and authorized code path. Any repair needs a separately reviewed invariant-preserving plan.                                       | Security/product/data owners; never manually set active, bypass D1, erase proof or rewrite balances.                                     |
| Concurrent Restore/Leave                     | Read final authoritative pair and transitions; successful Leave must remain left/closed. Restore needs a fresh current basis after approved clearance; suspended state is not self-clearable.                                       | Existing service behavior; anomalies escalate, not “retry until active”. Preserve one transition per accepted request.                   |
| Compatible forward recovery / backup cutover | Keep additive schema, inactive support, fresh consent and guard controls. For restore, isolate first, verify prefix/data/privileges, reconcile legitimate later writes and completed privacy/hold decisions before traffic changes. | Separate forward-fix, snapshot/restore and cutover approvals; actual RPO/RTO, data-loss acceptance and operator names remain unresolved. |

Emergency containment is not a magic existing switch. Current pointer NULL on T2
blocks new customer acceptances after lock/drain completion, but not platform
clearance, existing active members, independent awards, Feed or old code. Proposed
CONTROL-01 is **not implemented**; if no adequate approved mechanism exists, do not
activate and do not improvise a production shutdown. Never change secrets, providers,
notifications or unrelated customer/business flows under this document.

## Proposed policy publication/withdrawal operating sequence

Approve exact legal/localized bundle and roles first. Validate full source-authority
schema, hash manifest, dates and version before a privileged staged write; database
guards alone are not the complete validator. Capture protected approval/publisher/
previous-current/new-current evidence. Require a reviewed transaction/evidence path
before any pointer change; if mandatory audit cannot be demonstrated, hold and
request separately scoped tooling rather than claiming it exists.

Logical supersession selects another approved immutable current publication; do
not UPDATE an approved row to change its text or status. Withdrawal may select a
NULL pointer only under separate approval, preserving every past publication and
acceptance. Staged publication, making current, emergency withdrawal and restoring
availability are distinct approvals, not powers inherited from community:adjust or
post-moderation quorum. Do not backdate approval/effectivity or solicit consent to
an unapproved draft. A future-effective record cannot be current until valid.

## Proposed version/effective-publication process — D04/O4 coordination

1. Resolve the canonical policy, four legal artifacts and material-change/legacy
   ruling with qualified reviewers. Select an approved unique nonempty version
   within the runtime's 100-character limit; the existing candidate is not approved.
   Never reuse a version for changed content or borrow a business/authentication label.
2. Record the authorized publication UUID, approval reference/time, publication and
   effective dates. Existing runtime checks require approval not after publication,
   and all relevant dates not in the future when current. It does **not** by itself
   establish a legal notice period or enforce publication-before-effectivity as a
   separate ordering rule. A proposed approval -> publication -> effectivity schedule
   needs Owner/legal acceptance; any stronger automatic rule needs a separate dispatch.
3. Freeze exact UTF-8 artifact bytes and compute existing SHA-256 content hashes.
   The existing canonical manifest binds purpose, publication ID, version, publication/
   effective dates and locale-sorted artifact hashes. Review the exact final payload
   through the real validator; do not hash a draft and call it approved evidence.
4. With separate publication authority, stage the immutable approved record and its
   audit/approval evidence. It remains non-current and supplies no customer acceptance.
   Making it current is a separate G8 action after dates, deployment and other gates
   are verified. A published/approved row cannot later be edited to correct an error.
5. A newly approved version may supersede by current-pointer selection. Withdrawal
   may select NULL only with its own approval. Preserve old versions and acceptance
   mappings; current-pointer movement does not itself reaccept or terminate customers.
6. Any changed legal translation, material terms, notice or nonacceptance effect
   returns to D01–D04 review. Keep existing no-fabricated-backfill/no-unapproved-new-gate
   behavior until an explicit amendment is approved and implemented if necessary.

## Operating-model acceptance packet

Named people/deputies and approval references; policy/localization/privacy decisions;
actual release protection and connection roles; current backup/recovery rehearsal;
verified containment/cutoff and compatible release versions; support/dispute and
retention rehearsal; approved signal/threshold/destination access; incident drills;
and separate environment-specific rollout/customer-scope permission. The proposed
AR01 state-changing-step approvals remain required; AR02 does not combine them.
