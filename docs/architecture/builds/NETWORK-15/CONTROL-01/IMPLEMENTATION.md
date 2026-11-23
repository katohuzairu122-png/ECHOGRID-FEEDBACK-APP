# NETWORK-15-T2-CONTROL-01-R1 — enrollment and clearance containment

Development only. No shared configuration, migration, policy publication, deployment,
activation or T3 authorization. Starting main: `a026bdf1478c5d2de039ecf3b1f71484691fabe8`.
#562, #563 and #565 are merged. The current dispatch authorizes implementation of
AR02's proposed four-control option; its legal and operational approvals remain separate.

## Entry-point inventory

587 API source/operational-script files and 182 integration/helper files were inspected
at the starting main via the connected repository. No AGENTS.md or CLAUDE.md exists
in that tree. Searches cover Community ORM names, physical table name and service
constructors. Provisioning SQL only grants/verifies existing table privileges;
historical migrations are schema definitions, not runtime activation commands.

| Entry / caller | Service and transaction | Repository write | Authorization / control | Regression |
| --- | --- | --- | --- | --- |
| POST /api/v1/community/me/join, absent member | join(), registry shared lock -> customer row -> account | create(active) | customer middleware, live active identity, verified phone, explicit current consent; Join gate and opaque repository permit | controls PG/HTTP/Chromium; T2 runtime |
| Same route, left member | same transaction, state-derived rejoin | updateStatus(active), conditional prior state | Rejoin gate; Join/body cannot select it | controls PG/HTTP/Chromium; T2 concurrency |
| Same route, inactive member | same transaction, state-derived restore | updateStatus(active), conditional prior state | Restore gate; fresh D1 consent | controls PG/HTTP/Chromium; D1 races |
| Same route, active idempotent replay | existing consent determines original operation; no membership write | none; route would reevaluate awards after success | original operation gate must pass before returning replay success | controls PG/HTTP |
| Direct internal join() call | same authoritative transaction | same repositories | default-off constructor; server config only, never raw acceptance fields | controls PG; T2 runtime |
| POST /api/v1/platform/community-points/:customerId/restore | restore(), shared registry lock -> customer/account locks | suspended -> inactive; account closed; revoke projection + nonconsent barrier | existing live staff role/permission, active/verified customer; separate Clearance gate | controls PG/HTTP; D1 |
| Direct restore() call | same transaction | same guarded inactive write | default-off Clearance; never active or customer consent | controls PG |
| Direct repository create/update | caller DB / transaction identity | active insert / active or inactive update | opaque permit bound to DB object, customer, operation; status-derived operation rechecked and conditional update | controls unit/PG |
| Leave, owned withdrawal | existing customer-row transaction | left/closed and consent revocation | existing ownership, suspension and state rules; no enrollment gate | controls PG/HTTP, existing D2/T2 |
| Platform suspend | existing customer/account transaction | suspended/suspended | existing current role/permission; no enrollment gate | controls PG/HTTP |
| Queue, scheduler, admin adjustment, award, reversal, survey and loyalty resolver | no activation writer found | independent accounting or read-only membership lookup | existing independent authorization retained | full integration regressions |

Customer enrollment is global: a business/tenant request cannot supply an identity
or tenant to the Community Join schema. Staff, cashier and impersonated credentials
do not become customer authority. Existing QR requirements apply to independent
business operations; Community enrollment introduces no QR exemption or new QR proof.

## Configuration contract

| Operation | Exact server binding | Enabled value |
| --- | --- | --- |
| Initial Join | COMMUNITY_MEMBERSHIP_JOIN_ENABLED | string "true" only |
| Rejoin | COMMUNITY_MEMBERSHIP_REJOIN_ENABLED | string "true" only |
| Customer Restore | COMMUNITY_MEMBERSHIP_RESTORE_ENABLED | string "true" only |
| Platform clearance | COMMUNITY_MEMBERSHIP_CLEARANCE_ENABLED | string "true" only |

No master activation flag and no Feed coupling. Bindings are optional; absent and
"false" disable, all malformed values fail closed. No wrangler/deployment binding
is allocated, inherited or enabled by this change. Constructors snapshot the four
raw server values. No process-global enablement, HTTP override, administrator bypass
or environment inference exists.

The domain service selects the actual operation while holding existing locks.
The repository also rejects missing/forged/cross-customer/cross-DB permits and
inappropriate operation permits. Permits are internal opaque objects, never returned
or serialized. They convey containment approval only; existing identity, consent,
transaction and platform-authorization checks remain mandatory. Privileged raw SQL,
old application versions and trusted code that explicitly supplies enabled config
are outside a request-binding control's security boundary.

Disabled, otherwise eligible mutations answer HTTP 503 /
COMMUNITY_MEMBERSHIP_OPERATION_DISABLED with generic retry text. Authentication,
schema, account, phone, suspended and missing-authority failures retain their
existing boundaries. Denial writes no membership/account/grant/barrier, no
acceptance audit, no points/ledger, and never reaches pending-award reevaluation.
Active memberships, balances, evidence and authenticated sessions are retained.

GET status/terms remain read-only. Offers add optional server-derived
activationAvailable; Web treats absent/false as closed and presents localized
temporary unavailability plus refresh. Terms remain readable. Old Web may reject
the additional strict offer field and fail closed; mixed-version readiness must
still be verified. Leave and account Settings/phone handoff remain independently
authorized. No OTP, optimistic membership, consent or enrollment is inferred.

## Atomicity, concurrency and exact cutoff

Controls do not add storage or change migration 0088. Existing registry shared
lock -> customer row -> account ordering, publication currentness, immutable
evidence, D1 fresh Restore and D2 protections are retained.

The guarantee is a **constructor-time immutable request snapshot** of the server
binding values. Fresh requests handled by a guarded Worker revision with disabled
values cannot activate or clear, including replays. A captured enabled request
can still commit after a subsequent configuration/deployment change, even if it
was waiting on a database lock. Service reuse deliberately retains its snapshot;
production routes construct services per request.

This is not linearizable cluster-wide revocation. No env edit cancels a running
transaction or proves traffic has drained from old Worker revisions. A stronger
durable cutoff/cohort registry requires a separate architecture decision. The
existing approved pointer-to-NULL procedure can serialize acceptance barriers
against shared registry locks; it does not stop clearance or post-commit awards,
and no pointer change is executed or authorized here.

## Privacy-safe evidence

Fixed event: community_membership.control.
Operation: join, rejoin, restore, clearance, activation.
Reason: permitted, disabled, invalid_configuration, missing_permit, transition_failed.
At most one event for each operation/reason per Worker isolate (bounded in-memory
set); this is representative diagnostics, not request counts or a durable audit.
Success is emitted after transaction completion. No raw errors, identifiers,
contacts, tokens, payloads, proof, consent or arbitrary metadata are logged.
Logging exceptions cannot affect authorization or transaction results.
Destinations, alert thresholds and retention remain separate O9 approvals.

## Non-executed release and configuration checklist

- Read shared binding metadata without retrieving secrets; verify the four names
  and values independently per environment. Live state has not been certified.
- Approve the exact API/Web guarded revisions and target migration range separately.
- Keep all four bindings absent/disabled during first deployment.
- Prove every routed version uses containment and the old versions have drained;
  inspect in-flight/post-commit work before claiming a cutoff.
- Preserve an available rollback revision that retains guards, inactive state,
  current consent validation, evidence, reads and Leave. Legacy rollback is unsafe.
- Approve legal/localized artifacts, publisher authority, recovery, operations and
  separate customer-scope activation before enabling any individual operation.
- Reenable only through a separately authorized environment action; retain fresh
  explicit consent. Green tests, PR review and merge never enable the feature.

## Validation

Hosted validation is pending at the initial implementation commit. Exact final-head
results and any limitations are recorded in the completion report/PR. Existing CI
runs API/Web units, PG16/PG18, static/type/build/migration checks; NETWORK-05 runs
the actual HTTP/PostgreSQL harness and real Chromium on the built Next application.
No protected deployment workflow is modified.

## Read-only shared configuration observation (23 November 2026)

Worker settings metadata was read for `echo-grid-feedback-api` and
`echo-grid-feedback-api-staging`. All four operation bindings and the earlier
proposed master binding were absent on both. Only presence/type and classification
of the named nonsecret controls were requested in the returned evidence; secret
values were not retrieved. No settings were modified. Absence is safe for the new
guarded code but does not prove that deployed revisions contain those guards.

## Validation remediation

The first HTTP lifecycle run detected an existing concurrency fixture using two
simultaneous domain transactions on one pg Client; PostgreSQL logged overlapping
BEGINs. Conditional repository state checks exposed that invalid fixture model.
The race now uses separate clients, retains real concurrent Join/Leave operations,
and accepts only the documented stale-acceptance rejection. No assertions or
production locks were relaxed. Added a deferred-read unit regression for mutable
repository inputs and an actual blocked-transaction test for snapshot/drain limits.
