# BDPN D-18 v1.1 — Proposed Contracts, Threats and Acceptance
Status: PROPOSALS ONLY; not evidence of deployed endpoints or tables.

## Suggested server capabilities (names to reconcile with actual entitlement catalog)
- `business.discovery`: platform-approved neutral directory publication, independent of paid plan.
- `loyalty.remote_enrollment`: qualifying subscription plus business opt-in.
- `community.promotion`: separate qualifying subscription plus platform moderation.
These keys are design labels, not confirmed existing schema keys.

## Proposed endpoints (reconcile paths, roles and existing APIs before implementation)
GET /community/businesses (approved published DTOs only)
GET /community/businesses/:handle (opaque handle, published DTO only)
GET /community/businesses/:handle/enrollment-options (already-member/remote-eligible/visit-to-scan)
POST /community/businesses/:handle/join (authenticated, explicit consent version, idempotent)
POST /community/businesses/:handle/enrollment-interest (authenticated, explicit action, rate-limited)
GET /business/community/enrollment-demand (authorized business roles, aggregate only)
PATCH /business/loyalty/remote-enrollment-settings (authorized business roles, opt-in only)
POST /business/community/promotions (authorized business role, submission only)
GET /community/promotions (approved + entitled + published only)

## Remote join state machine
Customer authenticated -> selected published active business -> already enrolled? show existing account -> otherwise entitlement valid AND business opt-in AND program/customer eligible? -> disclose current business terms and obtain explicit join consent -> transactionally reuse existing membership creation -> display business-specific loyalty card. Otherwise display visit-and-scan instructions and optional 'I'm interested in joining'. Never join on scan alone, browsing, interest or marketing consent.

## Interest state machine
Explicit customer action -> authenticated customer, published business, remote joining unavailable -> deduplicate customer/business/time window and rate limit -> record minimal event -> acknowledge without creating membership -> privacy-thresholded aggregated demand -> show enable (entitled/off) or upgrade (not entitled). No raw identity to merchant; no email/SMS/push from this event. Proposed minimum aggregate 5 unique customers in 7 days; exact values require privacy/abuse approval.

## Promotion state machine
Authorized business draft -> independent promotion entitlement -> submission -> platform moderation -> published in-app discovery. Revoke/unpublish on suspension or entitlement loss. Do not hide independently authorized existing loyalty rewards/surveys. No outbound sends under this design.

## Acceptance tests
A1: all active approved published businesses appear independent of paid tier; unapproved/suspended/withdrawn absent.
A2: arbitrary business ID, unknown handle, foreign tenant and unpublished business cannot be used to join or read private data.
A3: QR flow remains customer-consented and idempotent; customer QR is not business QR; no silent enrollment.
A4: remote joining requires entitlement + business opt-in + customer explicit consent; fails closed on stale/unknown plan and business status.
A5: same global customer can enroll in two businesses with separate loyalty ledgers; repeated join does not duplicate account or points.
A6: downgrade or opt-out stops new remote joins without deleting existing memberships, rewards, points or consent history.
A7: interest clicks do not create memberships, points, marketing consent or business contact permissions; dedup and rate limits work.
A8: business sees only privacy-thresholded aggregates and correct upgrade/enable guidance, never raw identities or foreign-tenant data.
A9: only separately entitled, approved content appears in discovery; no implicit survey participation, financial credit or external messaging.
A10: platform marketing consent is not inferred from signup, QR, interest, loyalty membership, survey or Community membership.
A11: verify concurrent joins, entitlement change races, signed QR expiry/replay, auditability, privacy retention and safe rollback.
A12: synthetic staging E2E passes on integrated owner-merged main; physical scanner tests separately labeled if unavailable.

## Existing contracts to preserve
CUSTOMER-AUTH-01 explicitly states BDPN D-18 must be amended before remote joining; existing QR join passes verified qrToken and consentVersion. BDPN-01 discovery must rely on platform-approved published revisions; do not use the generic public business lookup as publication authority. Split 05 Community membership is explicit and separate. Keep billing, points, partner credits, settlements and existing auth/security restrictions unchanged.

## Non-authorization
No migration, runtime code, PR merge, deployment, customer notification, Twilio/Stripe action or production changes authorized by these documents.
