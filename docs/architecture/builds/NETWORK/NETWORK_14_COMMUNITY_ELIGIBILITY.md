# NETWORK-14 — Community eligibility and progressive verification

Date: 2026-11-21. Development/testing only; no activation or deployment.

## Reconciliation and bounded scope

Baseline main: `6beab35d5ffdd0b3e953b224e1ac769c507e7b99`.
NETWORK-13 (#545) is merged, including closed Feed response validation and
malformed-response recovery. CUSTOMER-AUTH-UX-01 (#546), branch
`feat/customer-auth-ux-01`, was draft/unmerged at head
`11083bd89a2d5faa69942aff129d01f33f06a3b6` during reconciliation.
None of that authentication branch is imported.

The independently safe correction distinguishes the existing server error
`PHONE_VERIFICATION_REQUIRED` from other access denials and offers an explicit
account-verification handoff. It does not change the underlying eligibility
policy. No API, permission, feature flag, schema or OTP implementation is added.

## Pending Owner ruling N14-READ-01 — NOT APPROVED / NOT ACTIVATED

Recommended, pending explicit approval: allow an active authenticated customer
without a verified phone to read permitted published official Feed content.
Keep authentication, feature gates, publication/expiry filtering, audience and
tenant boundaries, moderation and all independently approved participation
requirements in force. Phone verification must not grant publishing/moderator
permissions or replace normal authentication.

This assignment explicitly says the exemption is a recommendation subject to
policy reconciliation. Main has no approval of this precise exemption:

- `CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md`, stage 4, and
  `lib/customer-verification.ts` govern existing verification gates.
- `NETWORK_08_FEED_ACCESS_VERIFICATION.md` verifies phone-revocation denial.
- `NETWORK_12_FEED_CURSOR_RELIABILITY.md` records the active/verified reader rule.
- `NETWORK_13_FEED_RESPONSE_RECOVERY.md` explicitly defers this policy issue.
- NETWORK-00 reserves customer posting and engagement pending further decisions.

Consequently the production `communityFeedRoutes` still calls the existing
server-side `assertVerifiedPhone(..., 'network')` on every Feed request. There
is no dormant runtime switch, client query, return flag or alternative endpoint
that activates the proposed exemption. NETWORK-14 as a whole remains BLOCKED on
N14-READ-01; passing CI on this bounded correction does not resolve that ruling.

Smallest next action: Owner explicitly approves or rejects N14-READ-01. Approval
requires a separately reviewed Community enforcement change and positive
unverified-reader HTTP/PostgreSQL/browser acceptance; this PR does not claim
that behavior is enabled.

## Eligibility matrix

| Action | Classification | Main/current behavior | Proposed change / dependency |
| --- | --- | --- | --- |
| Public landing information | Public information | Existing public route | None |
| Customer dashboard | Authentication | Valid current customer session; existing auth feature configuration | Normal password registration/login remains authentication-owned |
| Own business memberships | Business membership authorization | Session customer scope and existing membership rules | None; no balance/history changes |
| Read permitted published Feed | Viewing eligibility | Active authenticated customer AND authoritative verified phone AND Feed flag | Session-only viewing pending N14-READ-01 |
| Read official announcement | Viewing eligibility | Same Feed contract; published/live-approved/nonexpired only | No new detail endpoint |
| Community join | Participation eligibility | Existing authenticated `POST /community/me/join`; verified phone and existing policy-version/membership rules | No new UI or policy |
| Customer content / reactions / comments / reporting | Participation | NOT IMPLEMENTED / NOT AUTHORIZED in v1 | No new capabilities in this block |
| Official creation / moderation | Moderator authorization | Current platform permission/role validation; customer tokens denied | Phone status grants no platform authority |
| Official approval/publication | Moderator authorization | Existing independent two-reviewer rules and lifecycle | Unchanged |
| Another customer's or business's private data | Tenant/customer authorization | Existing route-specific scope; Feed accepts no customer/business selector | Never authorized by phone status |
| Sensitive credential changes | Account-security step-up | Existing account service reauthentication/step-up policy | Authentication workstream, untouched |

Additional-business join requires the existing verified-phone gate; initial
business join/basic existing loyalty retain their separate contracts.
Phone verification and valid session authentication are distinct checks.

## Existing identity and Settings handoff

Main already provides `/loyalty/dashboard/phone` and its server-authoritative
`GET /loyalty/me/phone` (masked number + boolean only). The existing authenticated
page supports a safe `next` parameter and does not send an SMS on opening.
NETWORK-14 links there only after an explicit customer choice. The Feed UI:

1. Recognizes **403 plus the exact stable error code**, not message text.
2. Explains the current policy in en/fr/es/ar.
3. Offers account verification or Points & Membership; never redirects itself.
4. Uses a fixed internal verification route and a Feed-only, bounded opaque
   cursor return path; an arbitrary destination/verification flag is not accepted.
5. Reads the Feed again on return; no client-controlled status grants access.

PR #546's fuller `/loyalty/dashboard/settings` is unmerged. This PR uses the
existing approved verification-required handoff, not a broken Settings link.
Future Settings navigation is an authentication dependency; no registration,
password login, legacy upgrade, session issuance/rotation or OTP code is changed.

Community join has no customer UI on main. Higher-trust rejection/success are
therefore verified through its actual HTTP service; no engagement screen is
invented. Browser tests simulate the **separate account workstream** completing
phone verification by changing only a synthetic fixture in disposable PostgreSQL.
They do not claim real SMS, phone ownership, password login or PR #546 acceptance.

## Preserved boundaries and verification

API production code is unchanged. The existing middleware revalidates current
customer/session state, and existing queries enforce publication, approved live
revision, expiry, pinned-first ordering and precise pagination. The current
source projects official-only DTOs; business-authored/private customer content
and customer engagement are not activated.

The shared Community lifecycle harness now mounts the actual existing
`loyaltyCustomerRoutes`, including its own authentication/rate limiter, solely
to exercise the existing account status page. Only the Worker database adapter
is substituted with a real disposable PostgreSQL connection; authentication,
Feed routes, membership service and moderation remain real.

Added regressions cover missing/unverified/inconsistent phone state, current
policy denial, masked status projection, read-only handoff, no join side effect,
valid verified participation, customer-scoped membership, spoofed query rejection,
platform endpoint denial, and revoked/expired/suspended rotating sessions through
the actual Feed middleware. Existing Network suites retain visibility, tenant,
quorum, concurrent approvals, pinning, expiry and cursor regressions.

Chromium acceptance covers English/Arabic, 375px/1280px, RTL, keyboard activation,
44px handoff target, no overflow, explicit navigation without SMS or mutation,
return-without-verification denial, authoritative status re-evaluation, and
verified-customer moderator denial. Positive unverified viewing remains BLOCKED
by the pending ruling; no test result is represented as approval.

No database migration, migration journal change, shared database access, customer
identity mutation outside synthetic fixtures, loyalty/Community ledger change,
production configuration change, deployment or merge is included.
