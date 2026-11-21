# NETWORK-15 — Community membership self-service

Development baseline: `c0be450e2d6087d751b6c6e63d8690fd412aa8c4`, 2026-11-21.
PRs #546 and #547 are merged. Authentication's unfinished legacy upgrades,
registration proof continuation and targeted browser acceptance remain separate.
PR #548 (`docs/network14-n14-read01-rejected`, head
`065b25ab909aee3166cc445f2d767668b8cf6762`) was draft/unmerged during reconciliation.
No changes from it are imported. The Owner's explicit ruling **N14-READ-01 is
REJECTED** nevertheless governs this block: Feed reading still requires current
customer authentication, active identity, authoritative verified phone, enabled
Feed and publication visibility. The historical pending wording in NETWORK-14
is superseded by that ruling; #548 owns its documentation update.

## Approved contract and implementation

Actual mounted routes are `GET /api/v1/community/me`,
`POST /api/v1/community/me/join`, `POST /api/v1/community/me/leave`.
`CommunityMembershipService` serializes operations by locking the customer row.
Explicit join creates/reuses one membership and one separate Community Points
account; left may reactivate, suspended may not. Leave changes active to left,
closes the Community Points account, and retains its balance and append-only
history. Repeated leave is idempotent. Business loyalty is not touched.
The existing join route invokes `reevaluatePendingMembership` after membership
commit; pending-award releases are real ledger effects under existing rules,
not values the UI may calculate. The join-route reevaluation call, award rules and amounts remain unchanged.

Customer controls are nested in **Community > Points & Membership**. The status,
dates, existing Community Points and history are still read from existing APIs.
Absent and left customers see disabled Join/Rejoin and an honest prerequisite
notice. Unverified customers can explicitly open the existing account-phone
page with a fixed Community return destination, or Account Settings now on main.
The authoritative phone status is re-read; a client flag never establishes it.
Visiting either Community or verification does not enroll or send SMS.

An existing active member can explicitly open a leave confirmation dialog.
The cancel button makes no request. Confirmation requires a separate checkbox,
a pending state disables repeated submission and dismissal, and a Server Action
accepts no customer id, return target, policy version or verification assertion.
Only the existing customer-authenticated leave API performs the transition.
Its response is validated before success; the UI refreshes authoritative
membership and points data. Session redirects propagate. Failures remain
recoverable and do not become optimistic success. Suspended memberships expose
no self-reactivation/leave control; the API also denies such changes.

## Verified concurrency correction

A deterministic real-PostgreSQL regression blocked an award on the account row
lock after its initial active-status read, then committed a concurrent leave's
left/closed state. Before correction the award still succeeded and credited 80
synthetic fixture points into the closed account (the regression and subsequent
expected-pending-release assertion both failed). The smallest correction re-reads
and requires an active account after acquiring the existing account lock, before
writing any decision/ledger/balance change. A closed/suspended/missing account
returns the existing `COMMUNITY_ACCOUNT_NOT_READY`; the pending decision and
ledger remain unchanged. No lock is added, no lock order changes, and valid
later rejoin/release retains its existing exactly-once behavior. This is an
eligibility-race correction, not a new earning rule or ledger rewrite.

## Terms prerequisite — BLOCKED, no fabricated consent

The frozen Split 05 specification requires explicit Community opt-in and a
`policy_version` column, but no approved customer-facing terms, publication URL,
current version or accepted-version authority was found. Existing fixtures use
synthetic labels such as `community-policy-v1`; those are not approved terms.
The existing shared join schema accepts a bounded nonempty string. It is NOT an
approved-version allowlist or proof of customer consent.

Therefore this PR deliberately provides **no customer Join/Rejoin Server Action,
form or mutation handler** and sends no `policyVersion`. A disabled button is
informational and has no enrollment action behind it. This is not a claim that
the preexisting API now rejects every arbitrary nonempty version: its production
contract has not been redesigned. No customer may be newly enrolled through this
interface until the terms authority and genuine consent contract are approved.

Owner prerequisites N15-TERMS-01:

1. Approve actual accessible Community membership terms, their current version
   and localization/publication source.
2. Confirm the authoritative accepted-version validation and explicit acceptance
   evidence required at the API boundary, including rejoin requirements.
3. Authorize the corresponding narrow contract integration if the existing
   version field alone is insufficient; reconcile schema separately if needed.

No policy version, legal wording, consent retention rule or acceptance record is
invented here. UI Join/Rejoin acceptance scenarios are **NOT RUN — BLOCKED**.
The overall NETWORK-15 Definition of Done is consequently partial. The safe
status/verification/confirmed-leave delivery can be reviewed independently.

## Verification design and boundaries

All new mutations go through the established Server Action/customer API boundary.
No public mutation route, permission, earning rule, status, database migration,
authentication implementation or Community Feed renderer change is introduced.
Four locales (en/fr/es/ar), mobile/desktop, RTL, keyboard navigation and existing
workspace components/tokens are used.

New web tests cover confirmation, forged fields, safe response projection,
errors/redirects, no automatic mutation, disabled enrollment, suspension and
verification navigation. The actual HTTP/PostgreSQL lifecycle harness covers
read non-effects, unchanged phone state, no consent/notification/award creation,
customer-owned leave, account/ledger/business-loyalty preservation, duplicate
leave, existing synthetic service join/leave concurrency, and denied identities.
The existing rotating-session tests also deny revoked/expired/suspended sessions
on leave. Existing Community Points suites exercise legitimate pending-award
release and deduplication under synthetic service fixtures; this does not claim
UI terms acceptance or authorize new points rules.

Browser fixtures explicitly seed preexisting memberships using synthetic labels;
they do not fabricate customer consent or claim Join/Rejoin acceptance. Real
Chromium scenarios exercise absent/unverified status, no page-load side effects,
verification handoff, preserved Feed denial, active-member cancellation and
confirmed leave, disabled rejoin, and suspended-member API/UI denial at 375/1280
in English, French, Spanish and Arabic. Existing NETWORK-11/12/13/14 cases remain.
All database writes are disposable test fixtures. No live account, shared
migration, infrastructure, production/staging configuration, deployment, merge,
customer-auth, cashier, billing, B2B or R8-G/D2 implementation is changed.
