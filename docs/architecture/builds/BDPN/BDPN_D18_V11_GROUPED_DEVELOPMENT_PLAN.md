# BDPN D-18 v1.1 — Parallel Development Groups and Integration Gates
Status: DESIGN ONLY; NO DEVELOPMENT DISPATCH.
Baseline: main c895edb2507f969387ce1f7cb27679bb003beff9.
All groups begin with read-only repository inspection. Separate feature branches, separate draft PRs, exact-head CI and owner merge decisions. No group may overwrite shared staging; integrated verified main only for shared staging; previews for unmerged work.

## Group 0 — Architecture and Security Gate (must finish first)
D18-G0A: Reconcile BDPN D-18 with CUSTOMER-AUTH-01 CA-06/07/08, BDPN-01 profile publication and customer Community route.
D18-G0B: Reconcile Split 01/03 QR and customer membership consent, Split 05 Community Points, Split 08 entitlements, platform approval, survey/notification boundaries.
D18-G0C: Versioned decision amendment, authorization matrix, API DTO allow-lists, threat model, abuse/privacy/tenant tests, migration impact and owner decisions.
Deliverable: documentation-only draft PR; independent review and explicit owner approval before feature development.

## Group 1 — Universal Discovery (parallel after G0)
D18-G1A: Publish-only, tenant-safe discovery read model using approved profile publication; no reuse of unguarded /businesses/:id/public as publication proof.
D18-G1B: Customer Community directory/profile UI, discovery pagination, search and status presentation; read-only.
Gate: unknown/unpublished/suspended business never leaks; no customer data, consent, marketing, notifications or points; exact-head CI and isolated preview.

## Group 2 — Remote Enrollment Entitlements and Consent (parallel with G1 after G0)
D18-G2A: Server-side independent capability evaluation; active plan + business opt-in + publication + program eligibility. Explicit default-deny; business settings restricted to authorized roles.
D18-G2B: Remote join API contract reuses existing idempotent business membership and consent writer; no arbitrary business-id join bypass, no QR security regression, no purchase/points award.
D18-G2C: Customer join/visit-and-scan state and already-enrolled view; versioned consent, race/replay tests.
Gate: tenant isolation, entitlement downgrade, consent, idempotency, negative-path and no-financial-effect tests. Integration with G1 required for end-to-end UI.

## Group 3 — Enrollment Interest and Business Demand (parallel with G1/G2 after G0)
D18-G3A: Interest event design + minimal privacy-safe persistence, customer-triggered, rate-limited, deduplicated, non-membership.
D18-G3B: Aggregated business dashboard demand and enable-vs-upgrade guidance; no customer identities or cross-tenant reads.
D18-G3C: Internal notification/digest only after thresholds and privacy review; no unsolicited outbound delivery.
Gate: abuse, privacy threshold, customer deletion/retention, role authorization, no notifications on passive discovery.

## Group 4 — Community Promotion (parallel after G0, independent of G2)
D18-G4A: Separate `community.promotion` entitlement and platform content moderation.
D18-G4B: Approved offers/survey promotion read model; distinguish promotion visibility from legitimate existing survey/reward access.
D18-G4C: In-app discovery UI only. Outbound marketing requires separate BDPN-02 consent/approval gate.
Gate: no unapproved content, no cross-business audience export, no sends, no billing/credits/loyalty mutation.

## Group 5 — Integrated Staging Validation (after G1–G4 merged by owner)
D18-G5A: Verify merged main and staging deployment coordination; preserve existing 73+ migrations and active auth/security changes; re-read actual count.
D18-G5B: Synthetic customer: website sign-up -> discovery -> QR join -> eligible remote join -> ineligible interest -> business aggregated dashboard; existing member retention; promotions entitlement.
D18-G5C: Adversarial tenant, auth, consent, publication, throttling, replay, entitlement expiry and rollback checks.
Gate: exact integrated SHA, all CI and staging tests, owner production decision. No automatic production promotion.

## Dependency graph
G0 -> [G1, G2, G3, G4 in parallel] -> G5.
Within G2, entitlement + consent contracts precede remote mutation. Within G3, privacy contract precedes notifications. Within G4, moderation precedes published feed.

## Completion report per group
Main SHA; branch/head; PR link/status; file inventory; design decisions; tests/CI exact head; security/tenant/privacy checks; staging scope and evidence; unresolved blockers; no unapproved merge/deploy. Stop after each independently verified group.

## G0 status note (2026-11-15)
G0 owner-decision reconciliation is recorded in `BDPN_D18_V11_G0_DECISION_RECONCILIATION.md` (register status, Tier 1 proposed rulings pending owner approval, conflict status, approval
checklist). Sequencing: G0 -> E0 -> B2; B3/B4 only when their decisions are resolved; B5 stays blocked until OD-17 and its consent, security and prerequisite gates are approved; B6/B7 are
separately gated. Nothing is approved by that note.
