# NETWORK-15-T2-CONTROL-01 — Enrollment and Restore Containment

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED. PROPOSED DEVELOPMENT SPECIFICATION.
NOT IMPLEMENTED OR AUTHORIZED BY AR02.** See [D07/O7](READINESS_AND_OWNER_DECISIONS.md).
No environment flag, permission, API, schema or Worker change is made here.

## Verified gap and bounded purpose

`NETWORK_FEED_ENABLED` gates Feed/official-post moderation, not Community membership.
A NULL current publication prevents T2 customer acceptance but does not stop
platform clearance, legacy code, existing memberships or independent points work.
There is no dedicated independent Join/Rejoin/customer-Restore/clearance kill
switch or cohort control in the reviewed source. Safe handover/incident containment
is an activation blocker. This proposed block contains operations; it creates no
new engagement, publishing, points, authentication or moderator authority.

## Proposed controls — names require approval, they do not exist

Recommended option: independent default-off server controls for initial Join,
terminated-membership Rejoin, customer Restore and platform clearance. Proposed
names are `COMMUNITY_MEMBERSHIP_JOIN_ENABLED`, `COMMUNITY_MEMBERSHIP_REJOIN_ENABLED`,
`COMMUNITY_MEMBERSHIP_RESTORE_ENABLED`, `COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED`.
These names are a design proposal, **not existing configuration**. The proposed enabled value is the exact string `"true"`; unset, `"false"`,
case variants and malformed values are disabled. No
production values or toggles are allocated/changed by AR02. Owner may choose an
approved equivalent with the same behavior. No administrator override is presumed. Existing platform Suspend remains available
under its current permission; do not gate the entire platform router or block
security restrictions/independent adjustments as a shortcut.

| Boundary                                                   | Proposed required disabled behavior                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST /api/v1/community/me/join                             | Guard actual server-derived transition under existing customer/account/lifecycle validation; independently cover join/rejoin/restore. Never trust the requested operation to select a weaker gate. Enforce in the domain service as well as the route, including direct internal callers.                                 |
| POST /api/v1/platform/community-points/:customerId/restore | Separate clearance guard; preserve live-role/permission and customer eligibility. Disabled clearance creates no inactive state, revoked projection or barrier/audit acceptance.                                                                                                                                           |
| GET /api/v1/community/me and GET /terms                    | Remain authenticated read-only; preserve accurate status/current text and fail-closed missing authority. Proposed closed availability metadata may expose only actual operation availability, never raw config, role internals or secrets. This is a contract proposal requiring coordinated API/shared-types/web review. |
| POST /community/me/leave and owned consent withdrawal      | Remain under existing authentication/state rules, independent of enrollment controls. Suspended restrictions are not relaxed. Never strand an otherwise permitted Leave behind a new join gate.                                                                                                                           |
| Feed, business loyalty, independent Community accounting   | Existing rules unchanged. Controls do not terminate existing memberships, erase history, reset balances or stop independently authorized awards.                                                                                                                                                                          |

Proposed stable disabled response: authenticated, otherwise eligible mutation
receives safe HTTP 503 / `COMMUNITY_MEMBERSHIP_OPERATION_DISABLED`, no successful
mutation and no sensitive detail. This code is **not implemented**. Preserve
existing anonymous/invalid-session/role/schema/eligibility failure semantics and
avoid advertising privileged capability to unauthorized callers. No membership,
account, grant, acceptance/barrier, pending-award reevaluation or notification may
be created by a disabled call. Any safe denial telemetry is not consent evidence.
In particular, do not return an apparent idempotent Join success that falls through
to the route's post-commit award reevaluation while disabled. Refresh reads can
show an earlier already-committed success without a new mutation.

## Concurrency and deployment limits

Request-time environment controls are not by themselves a linearizable,
cluster-wide revocation of already-running requests or old Worker revisions.
Define the cutoff and drain/propagation proof explicitly; do not promise that an
env edit cancels a transaction already in flight. Reuse currentness/advisory lock
ordering and revalidate before writes. A separately approved pointer-to-NULL
transaction on T2 code provides an acceptance barrier after in-flight shared locks
finish, but not a clearance/global-points/Feed stop. Do not invent a new durable
registry or migration inside this block without separate architecture approval.

The first control deployment still needs a verified external handover plan for
legacy routes/clients; new flags cannot protect old code that ignores them.
Confirm all routed Worker versions and safe rollback revisions. If a requested
harder cutoff or cohort-limited pilot cannot be supported by the approved existing
controls, stop and request a decision; no cohort primitive is presumed. Keep
controls default-off in code/tests and enable nothing on deployment automatically.

## Customer UX and monitoring proposal

Within the existing Points & Membership controls, show an accessible temporary
unavailability state/disabled action using server-authoritative availability;
keep current membership/balance visible and permitted Leave available. Preserve
one Community tab, all four locales, RTL, keyboard operation, unchecked terms,
Settings handoff and recoverable status refresh. Do not initiate OTP or imply
consent because availability changed. No unrelated redesign.

Proposed signals: bounded operation/result/denial code, policy/transition references
only where approved, unexpected state/audit failure and rollout-version mismatch.
No contacts/tokens/raw metadata/high-cardinality personal data in metrics. Destinations,
thresholds, retention and safe denial auditing require O9 approval; no production
observability changes are included in AR02.

## Required future tests / Definition of Done

- Actual HTTP and direct service calls for each independent control, unset,
  malformed, false and enabled values; no cross-operation/body-flag bypass.
- Anonymous/expired/revoked/suspended customers; unverified phone; staff/customer/
  impersonation and revoked platform roles; no cross-customer/business mutation.
- Disabled calls/replays release no pending awards, create no consent/account/
  activation/barrier, and preserve business loyalty and history. Permitted Leave,
  withdrawal, status, Feed policy and independent accounting remain correct.
- Join/Rejoin/fresh Restore still require current explicit consent when enabled;
  prior consent reuse remains impossible. Test duplicate requests and failures.
- Race tests for disable/drain/pointer barrier, Restore/Leave, re-suspension and
  currentness; precisely separate in-flight completion from post-cutoff denial.
- PG16/18 and real Chromium at 375px/1280px, en/fr/es/ar, keyboard/RTL, accurate
  disabled messaging and no optimistic success. Preserve NETWORK regressions.
- Typechecks, lint, builds, actual role tests, exact-head CI and reviewable draft PR.
- Document first deployment/propagation, compatible rollback and safe reenablement;
  no shared migration, live flags, deployment or activation without separate approval.

Rollback must retain compatible guarded API/web, inactive state, immutable evidence
and read/Leave behavior. A rollback that removes the gate is not containment.
Owner acceptance of this specification is a **future** development authorization,
not G8, production configuration permission or automatic T3 advancement.
