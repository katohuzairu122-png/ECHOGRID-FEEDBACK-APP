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

## Owner ruling N14-READ-01 — REJECTED (2026-11-21)

**Owner decision:** REJECT the proposed exemption allowing an authenticated
customer without a verified phone to read Community Feed content. **Retain
verified-phone eligibility for all customer Feed reads**, including published
official announcements. A valid customer session alone is insufficient.

**Enforcement:** Keep the existing server-side
`assertVerifiedPhone(..., 'network')` requirement on every Feed request, in
addition to the current session, Feed feature gate, publication/expiry,
audience and tenant restrictions. The exact `PHONE_VERIFICATION_REQUIRED`
response and explicit account-verification handoff introduced in NETWORK-14
remain valid. Opening the verification page does not send SMS, join a business,
or grant Feed access; authoritative verification must be completed separately.

**Scope of this ruling:** It settles only Community **read** eligibility. A
verified phone does not grant platform publishing, moderation, new customer
engagement permissions, membership or other privileges. Ordinary customer
account authentication remains independent of phone verification. No exemption
switch, client-controlled flag or alternative Feed endpoint is authorized.

**Repository evidence and preserved contracts:**

- `CUSTOMER_AUTH_S5_01_EMAIL_AUTH_API.md`, stage 4, and
  `lib/customer-verification.ts` describe existing verification controls.
- `NETWORK_08_FEED_ACCESS_VERIFICATION.md` covers verification revocation.
- `NETWORK_12_FEED_CURSOR_RELIABILITY.md` records the active/verified reader rule.
- `NETWORK_13_FEED_RESPONSE_RECOVERY.md` preserves current Feed permissions.
- NETWORK-00 reserves further participation/publishing pending separate decisions.

**Disposition:** N14-READ-01 is **CLOSED — REJECTED**, not pending. The existing
API guard already matches this decision; NETWORK-14's verification handoff
(#547) is merged. No enforcement change, migration, feature flag, deployment or
new verification flow is required by this decision record. A future change to
read eligibility requires a new explicit Owner ruling and independently verified
server-side/security/browser acceptance.

## Eligibility matrix

| Action | Classification | Main/current behavior | Owner ruling / dependency |
| --- | --- | --- | --- |
| Public landing information | Public information | Existing public route | None |
| Customer dashboard | Authentication | Valid current customer session; existing auth feature configuration | Normal password registration/login remains authentication-owned |
| Own business memberships | Business membership authorization | Session customer scope and existing membership rules | None; no balance/history changes |
| Read permitted published Feed | Viewing eligibility | Active authenticated customer AND authoritative verified phone AND Feed flag | **N14-READ-01 rejected: retain verified-phone requirement; no exemption** |
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
verified-customer moderator denial. Unverified-phone Feed viewing remains **DENIED** under the Owner's rejected
exemption; no test result is represented as permission to bypass verification.

No database migration, migration journal change, shared database access, customer
identity mutation outside synthetic fixtures, loyalty/Community ledger change,
production configuration change, deployment or merge is included.
