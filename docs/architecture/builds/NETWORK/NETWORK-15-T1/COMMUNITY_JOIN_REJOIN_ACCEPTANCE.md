# Community Join/Rejoin acceptance — non-activating T1 matrix

**Status: PROPOSED CONTRACT / NO FEATURE ACTIVATION.**
Reference models validate a design against synthetic inputs. They are not the
production service and cannot prove that its legacy Join endpoint enforces these
new requirements. PostgreSQL characterization proves current storage properties,
not approval of the missing Community purpose/registry. Existing NETWORK-15
HTTP/Chromium tests prove current disabled UI and permitted Leave behavior.

## Join requirements

| ID | Proposed mandatory requirement | Current implementation / remaining gate |
| --- | --- | --- |
| JOIN-01 | Authenticate through existing customer session middleware | Existing; unchanged |
| JOIN-02 | Revalidate authoritative verified phone | Existing; unchanged |
| JOIN-03 | Active identity and allowed membership/account moderation state | Existing checks; future guard must preserve all restrictions |
| JOIN-04 | Resolve approved currently effective terms server-side | Missing; registry/approval required |
| JOIN-05 | Literal explicit acceptance of exact displayed version/hash | Missing in legacy Community API; UI disabled |
| JOIN-06 | Acceptance evidence, membership and account change atomic | Missing acceptance integration; future transaction gate |
| JOIN-07 | One membership/account/acceptance per matching transition replay | Existing membership uniqueness; future consent binding required |
| JOIN-08 | No business loyalty or Community Points economic rule changes | Existing separation; preserve pending-award effects |
| JOIN-09 | No join from tab open, QR, login or phone verification | Existing safe UI/read contracts; maintain on every gateway |
| JOIN-10 | No approved terms fails closed | UI disabled; legacy API contract gap must be closed before activation |

## Rejoin requirements

| ID | Proposed mandatory requirement | Current implementation / remaining gate |
| --- | --- | --- |
| REJOIN-01 | Existing valid current session, not a new identity/login service | Existing session model; no forced new login protocol |
| REJOIN-02 | Recheck authoritative phone assurance | Existing; no client flag |
| REJOIN-03 | No customer override of suspension/moderation | Existing; preserve membership/account restrictions |
| REJOIN-04 | Explicit currently effective terms acceptance | Missing acceptance integration |
| REJOIN-05 | Prior acceptance cannot substitute for the new required act | New event and lifecycle basis required |
| REJOIN-06 | Retain historical acceptance, membership and ledger identity | Reuse existing rows/history; append evidence |
| REJOIN-07 | No duplicate membership, points account or award | Existing uniqueness and award idempotency retained |
| REJOIN-08 | Serialize concurrent enrollment and scope idempotency | Existing customer lock plus future consent binding |
| REJOIN-09 | Leave/Join races consistent; old Join replay cannot resurrect | Existing state lock; future lifecycle evidence basis required |
| REJOIN-10 | Unknown, unapproved, stale or future-effective terms refused | Missing runtime publication authority; keep disabled |

## Security test mapping

| ID | Non-activating reference check | Runtime / database acceptance classification |
| --- | --- | --- |
| T1-01 | No approved publication denies Join | UI guard verified; proposed API terms guard NOT IMPLEMENTED |
| T1-02 | No approved publication denies Rejoin | UI guard verified; proposed API terms guard NOT IMPLEMENTED |
| T1-03 | Missing/false/truthy acceptance rejected | Reference only; Community API currently lacks this field |
| T1-04 | Unknown or unapproved version rejected | Reference only; legacy nonempty version is not an allowlist |
| T1-05 | Changed publication/hash/lifecycle basis refused | Reference only; real registry/change policy BLOCKED |
| T1-06 | Unverified phone cannot enroll | Existing HTTP/PostgreSQL gate + reference |
| T1-07 | Suspended customer/member cannot enroll | Existing auth/state tests + reference |
| T1-08 | Matching duplicate Join returns one transition/evidence | Reference; current service membership idempotency separately tested |
| T1-09 | Concurrent Rejoin yields one membership/evidence | Reference serialization; actual current customer lock separately tested |
| T1-10 | Evidence binds customer, artifact, action, time, transition | Reference only; persisted approved Community evidence BLOCKED |
| T1-11 | Leave retains prior evidence/ledger; stale Join cannot restore | Reference + existing actual Leave/history tests |
| T1-12 | Business loyalty snapshot unchanged | Reference + existing actual PostgreSQL non-effects |
| T1-13 | No point rule or amount change | Read-only/reference + unchanged production source diff |
| T1-14 | Client cannot select another customer | Reference strict request + existing actual auth/ownership tests |
| T1-15 | GET/navigation/authentication/QR has no enrollment action | Reference + current page/verification HTTP/Chromium non-effects |
| T1-16 | Client cannot forge current terms/time/verification authority | Reference strict request; authoritative phone/current UI guard preserved |

Additional reference checks: audit-write failure rolls back the proposed state;
future-effective terms are unavailable; no new active-member acceptance is inferred
from new keys; exact artifact hashing is stable and content-sensitive. Simulated
concurrency is explicitly not PostgreSQL lock evidence.

Disposable PostgreSQL characterization adds evidence that:

1. The current purpose CHECK rejects `community_membership` (no bypass).
2. A supported consent grant is mutable and must not alone be called immutable.
3. Existing audit INSERT works with null staff actor and pseudonymous customer
   context, while UPDATE/DELETE are refused by existing immutability guards.
4. A customer UUID is not a staff actor UUID; the existing FK rejects misuse.
5. A transaction aborted by the unsupported purpose leaves no newly activated
   membership/account, grant or acceptance audit event. This is a design probe,
   not a new runtime enrollment service.

## Customer experience specification (not published)

Within Community > Points & Membership, show accurate status and separate account,
phone assurance, business loyalty and Community Points explanations. Before any
future enabled Join/Rejoin: display the approved version/effective date, accessible
immutable terms link, applicable privacy link and independently unchecked explicit
acceptance checkbox. Neither reading nor scrolling checks it. Require a deliberate
Join/Rejoin press. Provide cancel/return controls without dark-pattern pressure.

Use existing en/fr/es/ar localization and Arabic RTL. Legal/native-language review
must approve the legal wording and any fallback. Test keyboard, screen-reader
labels, 44px controls, loading, error/retry and no overflow at 375px/1280px. A stale
view must offer the current terms and require a new deliberate act; never silently
upgrade the accepted version. Return from phone verification refreshes authoritative
status and NEVER auto-submits Join. Existing confirmed Leave remains unchanged.

T1 publishes no terms page, approval flag, legal effective date, consent checkbox
or executable Join/Rejoin control. A new web regression verifies the draft version
and acceptance checkbox are not presented as approved customer terms. Existing
Network Chromium regression coverage is rerun on the T1 head.

## Future executable acceptance / NOT RUN in T1

Authorized isolated implementation and approved reviewed terms are prerequisites
for successful Join/Rejoin/browser acceptance. Must later prove: atomic production
transaction rollback on evidence failure; current-version changes across Workers;
same/different-key concurrency; Leave and stale Join races; preserved grants/audit
history through allowed privacy lifecycle; no duplicate pending award release;
all gateways rejecting the old bare-version bypass; cross-customer and role denial;
accessible reviewed legal translations. Do not mark these passed because the
reference model or existing fixture joins passed. No skipped test is a success.
