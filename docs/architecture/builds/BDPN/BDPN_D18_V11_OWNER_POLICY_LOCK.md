# BDPN D-18 v1.1 — Owner Policy Lock (Proposed Amendment)
Status: OWNER PRODUCT DIRECTION LOCKED FOR DESIGN; architecture amendment REVIEW REQUIRED; runtime NOT AUTHORIZED.
Baseline main: c895edb2507f969387ce1f7cb27679bb003beff9 (2026-11-15).
Supersession: This proposal does NOT silently override locked BDPN D-18, CUSTOMER-AUTH CA-06/07/08, or other architectural decisions. Resolve and approve amendment before code.

## Invariants
1. One global Echo Grid customer identity; separate tenant-scoped loyalty memberships and ledgers.
2. All **active, approved, published** participating businesses are discoverable, regardless of subscription. Registration alone does not publish a profile. Suspended, unpublished, rejected or withdrawn businesses are excluded.
3. Existing business QR voluntary loyalty enrollment remains available subject to existing business/customer eligibility and consent. Scanning alone does not silently enroll or award value.
4. Remote enrollment requires an active qualifying subscription entitlement `loyalty.remote_enrollment`, affirmative business opt-in, active published business/program, eligible authenticated customer, explicit versioned join consent and all existing eligibility/verification rules. Missing/expired/unknown conditions fail closed. Remote join must not bypass purchase evidence.
5. Community promotional distribution requires a distinct `community.promotion` entitlement, business-submitted content and platform publication approval. This entitlement does not imply remote enrollment and vice versa; a plan may bundle both.
6. `business.discovery` means eligibility for neutral publication after platform approval, NOT automatic publication, promotional distribution, advertising consent or an unrestricted public directory.
7. A customer may signal voluntary interest in joining an ineligible/opted-out business. This is NOT membership, business contact consent, marketing consent, points or a reservation.
8. Business receives privacy-thresholded aggregated interest counts and the correct enable/upgrade guidance; never customer identities, contact details, membership in other businesses or raw request logs.
9. Existing members retain account/card, accrued points, rewards and permitted services when remote enrollment is disabled or downgraded. No automatic enrollment, backfill, marketing opt-in, partner credits, settlement or billing effects.
10. Customer Community Points membership is separate from business loyalty membership; scanning/joining business does not silently create Community membership.
11. Platform discovery in-app does not authorize SMS/email/push; separate versioned channel-specific consent and suppression controls are mandatory for outbound promotion.

## Capability decision matrix
| Business state | Directory | Existing QR join | Remote join | Community promotions |
| --- | --- | --- | --- | --- |
| Approved + published + active; no qualifying plan | Yes | Existing eligibility | No; visit and scan | No |
| Approved + published + active; qualifying remote plan, opt-in off | Yes | Existing eligibility | No; visit and scan | Only if independently entitled and approved |
| Approved + published + active; qualifying remote plan, opt-in on | Yes | Existing eligibility | Yes with customer consent | Only if independently entitled and approved |
| Unpublished/suspended/inactive | No | Existing policy determines availability | No | No |
| Already enrolled customer, remote entitlement revoked | Only if still published | Existing policy | No new remote join | Existing membership remains accessible through authorized routes |

## Decision rationale
Universal neutral discovery improves customer utility and creates measurable upgrade demand without transferring private customer relationships. Remote joining and promotions are monetized independently. The customer-facing message for disabled remote join is 'Visit this business and scan its QR code to join'; never claim an online membership was created.

## Locked constraints and open implementation decisions
- BDPN D-18 existing informational-only join rule remains authoritative until the versioned amendment is independently approved.
- Reconcile plan/entitlement authority with Split 08; do not invent plan names or prices.
- Decide interest deduplication window, minimum reporting threshold (proposed >=5 distinct customers), daily digest, abuse and privacy protections after security review.
- Determine existing program eligibility/purchase requirements per business; never assume remote join awards points.
- Decide the independent content entitlement, moderation and survey-discovery contracts without weakening existing survey participation.
- No implementation, migration, secrets, notifications, external sends, staging or production deployment authorized by this file.
