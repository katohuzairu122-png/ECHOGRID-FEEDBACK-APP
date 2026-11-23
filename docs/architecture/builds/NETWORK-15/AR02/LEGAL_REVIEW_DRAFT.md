# Community participation, consent and privacy — legal review materials

**DRAFT — LEGAL REVIEW REQUIRED — NOT APPROVED. NOT EFFECTIVE. DO NOT PUBLISH OR OBTAIN ACCEPTANCE.**
Review-document revision: AR02 working draft, not a runtime policy version.
Existing T1 candidate: `community-membership-v1.0` **UNAPPROVED**; approved version,
approval reference, publication/effective dates and jurisdictions: **NONE SET**.

This consolidates review points from the existing
[T1 English draft](../../NETWORK/NETWORK-15-T1/COMMUNITY_MEMBERSHIP_TERMS_DRAFT.md)
and [final D1 development rule](../NETWORK_15_T2_D1_APPROVED.md). It does not replace
that history or change published `/terms`, `/privacy` or any application wording.
Brackets are unresolved review instructions, never text to serve to customers.

The application label "consent" denotes explicit membership acceptance here; it
does not decide the legal basis for personal-data processing in any jurisdiction.
The appointed reviewer must resolve that separately.

## Proposed customer-facing terms — review draft only

### Separate membership and eligibility

Community membership is a separate relationship with Echo Grid, operated in the
current product by INFINICUS LLC. Your customer sign-in account, phone verification,
business-specific loyalty memberships and Community membership are different.
Joining a business or registering/signing in does not enroll you in Community.
Opening a page, scanning a QR code and verifying a phone are not consent.

Joining or reactivating Community membership requires your active authenticated
customer identity, authoritative verified phone and a deliberate acceptance of the
applicable approved terms. Phone verification alone grants no staff, moderator,
publisher or business privileges. [Review: eligibility/capacity/territories and
controller/operator identity; no age or jurisdiction is invented. Confirm any
free-membership proposition before including it in the approved text.]

### Initial Join, Rejoin and Restore

Use Join only when you choose to enroll after reviewing the displayed current
terms. After voluntary Leave, Rejoin requires a new explicit current acceptance;
it preserves your original identity, membership/account and historical accounting.
No prior acceptance is silently reused for that reactivation.

A suspended member cannot self-clear moderation. An authorized platform moderator
may clear the suspension, leaving membership inactive and its points account
closed. This is not customer consent or active membership. To restore that cleared
membership, you must separately review and affirmatively accept current terms
through Restore. **Every Restore requires fresh versioned customer consent**, even
if you accepted the same policy previously. The new acceptance and activation are
recorded together or neither succeeds. Repeated requests do not create new accounts
or duplicate acceptance. Changed terms/state may require review and a new action.

### Available capabilities and Community Points

Membership grants only independently authorized, actually available capabilities.
Feed viewing retains its existing active-customer, verified-phone, feature and
published-visibility rules; this draft does not add a membership requirement or
remove other visibility restrictions. Membership does not enable customer posting,
reactions, comments, messaging, advertisements or unrestricted official publishing.

Community Points are distinct from each business's loyalty balance. Joining,
Rejoining or restoring does not itself promise points, monetary value, cash payout,
transfers, redemption or new financial benefits. An explicit eligible activation
may release existing pending awards only under the existing server rules. Platform
clearance alone releases no award. Repeated requests must not duplicate awards.
[Review actual benefits and approved economic wording; introduce no earning,
expiry, forfeiture, exchange or liability rule.]

### Withdrawal, leaving and termination

Use the existing confirmed Leave control where your membership state permits it.
Owned Community-consent withdrawal uses the same membership-ending flow. Leaving
sets membership to left and closes its separate points account; current code keeps
its balance/history and unrelated business memberships/rewards. It does not delete
your global account or erase every historical record.

Suspended membership cannot use self-service Leave or Restore to override the
platform restriction. [Legal/privacy review must resolve required withdrawal,
request/support handling during suspension without promising an unimplemented
exception or restricting rights by draft wording.] Contact/request channel and
approved escalation wording: [UNRESOLVED]. No response or dispute deadline is set.

### Evidence, privacy and changes

An affirmative action records minimal customer/membership references, the actual
Join/Rejoin/Restore transition, exact policy/version, displayed language/content
hash and server time. Immutable audit proof is separate from its revocable current
consent projection. Leaving, withdrawal or clearance does not edit that proof.
Customer acceptance is not consent for marketing, contact sharing, business
loyalty or unrelated processing. Existing records are not backfilled as fictional
consent.

The applicable approved privacy disclosure must explain evidence access, retained
account references, legacy membership observations, withdrawal versus erasure,
holds, retention and backup treatment. [Approve privacy notice/version, lawful
purposes/basis, controller/processor roles, retention criteria and request channel.
No retention duration or universal deletion guarantee is supplied.]

Terms changes use a newly approved immutable version and exact localized text.
Continued use, authentication, viewing or a preselected checkbox is not a required
new affirmative action. Materiality, notice, reacceptance timing, effects of refusal
and already-active legacy membership treatment remain [OWNER/LEGAL DECISIONS].
This draft imposes no new Feed gate, suspension, points forfeiture or auto-acceptance.
[Legal review: general-terms relationship, contact/jurisdiction, required notices
and disputes. No arbitration, liability exclusion, refund right or legal compliance
certification is invented.]

## Proposed consent presentations — not application changes

| Action  | Draft affirmative wording for legal/native review                                                                                   | Required implementation mapping                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Join    | “I accept the displayed Community membership terms [version] and choose to join.”                                                   | Unchecked literal acceptance; operation join, current publication/hash/locale and initial lifecycle basis. |
| Rejoin  | “I accept the displayed current Community membership terms [version] and choose to rejoin.”                                         | New acceptance for left-to-active; current lifecycle basis; preserve existing identity/account/history.    |
| Restore | “I accept the displayed current Community membership terms [version] and choose to restore my membership after platform clearance.” | New operation restore after clearance barrier; never prior grant reuse; atomic evidence and activation.    |

These are review proposals, not approved UI/legal translations. [version] must be
resolved from the authoritative publication, never a customer-supplied arbitrary
label. No checkbox may be preselected. Declining creates no membership/consent;
existing state remains. No second OTP service or consent inferred from a return
from Settings is proposed. Current UI already supplies generic explicit acceptance;
any approved wording/presentation change needs its own reviewed implementation.

## Data-governance decision record

| Data/evidence                                             | Existing behavior                                                                                                                                                            | Required privacy/legal decision — UNAPPROVED                                                                                                                          |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global identity/session/phone                             | Existing customer identity and auth, no duplicate Community identity                                                                                                         | Applicable notice, roles/basis and account-security scope; do not rebuild auth.                                                                                       |
| Community membership/account ID, dates/status and balance | One of each per customer; left/closed and inactive/closed preserve history                                                                                                   | Purposes, access, termination, correction and retention treatment; no new ledger rule.                                                                                |
| Consent grant projection                                  | Community purpose/resource; business_id NULL; status may revoke; no Community raw request key in legacy global namespace                                                     | Revocation/expiry/access and retention criteria; distinguish projection from immutable history.                                                                       |
| Immutable acceptance event                                | Customer/membership/grant/transition IDs, policy/version, manifest/artifact, locale/time and previous basis; prior membership status/date/policy observation may be retained | Necessity, restricted investigation, retention/holds and linkage assessment, including prior observations. IDs may remain linkable; do not call them identifier-free. |
| Platform clearance                                        | Immutable non-consent event plus existing staff semantic audit; old active grants revoked                                                                                    | Staff attribution, reasons/access and dispute handling; clearance is not customer acceptance.                                                                         |
| Contact/credentials                                       | New customer acceptance metadata excludes phone/email/name, IP/UA, secrets and raw keys; other subsystem logs may differ                                                     | Verify broader log/queue/provider handling with their owners; no universal minimization claim.                                                                        |
| Business loyalty                                          | Separate business relationship, purpose and ledger                                                                                                                           | Keep its legal version/consent separate; accepting Community never authorizes another business.                                                                       |
| Anonymization/holds/retention                             | D2 retains identity-free customer shells and immutable proof; registry disabled pending approval; implemented execution category is onboarding events                        | Community-specific treatment and approved criteria; no generic consent purge or retention schedule exists.                                                            |
| Foreign-key deletion and backups                          | Mutable memberships/grants reference customer with cascade; supported privacy process anonymizes the shell, not raw deletion; backups retain prior data                      | Do not propose raw delete/cascade as privacy handling. Approve backup access/retention and reapplication of completed requests/holds after recovery.                  |

Approval fields: selected policy/basis per purpose; retention criterion/trigger and
exceptions; named reviewer/controller/operator; privacy disclosure revision;
request/dispute process; approved evidence access; backup/recovery decisions;
reference/date: **UNRESOLVED**. No data or retention behavior is changed by AR02.

## Informational reviewer reference, not a jurisdiction ruling

The existing T1 background reference was rechecked against the FTC's primary summary of its
[Bringing Dark Patterns to Light report page](https://www.ftc.gov/news-events/news/press-releases/2022/09/ftc-report-shows-rise-sophisticated-dark-patterns-designed-trick-trap-consumers).
It is background for reviewing clear choices and non-preselected consent, not
approval of these terms, a finding that US law governs, or proof of compliance.
The appointed reviewer must decide applicable law and the separate processing
basis; AR02 makes no legal certification.
