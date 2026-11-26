# Final consolidated registers (Owner decisions, legal, operations, translations)

> **Update 2026-11-26 (R0):** the Owner's rulings on G-D1…G-D11 and the operating structure O-1…O-12 are recorded, with their implementation and evidence status, in `OWNER_RULINGS_R0_2026-11-26.md`. L-1…L-6 and H-1…H-4 remain PENDING; D02–D05 are not yet individually ruled. O-6 targets (RPO ≤ 1 h, RTO ≤ 4 h, PITR 7 days, daily backups, 30-day retention) are approved for feasibility assessment only; see `R1_INFRASTRUCTURE_PREFLIGHT_2026-11-26.md` §6. The earlier statement that production "RPO ≤ 24 h is not met" is withdrawn: PITR retention is not an RPO, and 24 h was only a proposal. The "Owner ruling: PENDING" markers below are historical and are superseded by the R0 record where a ruling is recorded.


Date: 2026-11-26. Nothing here is approved; no approval is implied, and none has been fabricated. Existing rulings D-1..D-6 (TB-01/TSH-01) and the D01–D14 rows of `DECISION_REGISTER_BATCH_03.md` are NOT reopened; this register adds the decisions created by G1–G12 and re-states, once, the blockers the Owner must resolve. For every row the answer to "can development proceed?" is recorded as what was actually built behind fail-closed controls.

## A. Owner decision register (new, from G1–G12)
Columns: ID · decision · governing document · what is already true (built, fail-closed) · blocked operation until decided · options · recommendation · runtime stays disabled?

| ID | Decision | Governing document | Built and fail-closed today | Blocked until decided | Options | Recommendation | Runtime disabled? |
|---|---|---|---|---|---|---|---|
| G-D1 | Name the first fraud investigators and dispute resolvers, their scope (shuffle / drops / both) and any expiry | TSH-01 §9; TSH-08; G5 | Assignment lifecycle (scope, window, expiry, final revocation, audit) with database-enforced effectiveness; `governance_operators` is EMPTY; no route can assign | Reviewing, deciding and overriding any case | Named staff only; add expiry for contractors | Two investigators and two resolvers, never the same person in both roles | **Yes** |
| G-D2 | Approve decision policies per kind (fraud, dispute) and family (shuffle, drops): allowed decisions and minimum evidence items | G5 (`governance_decision_policies`) | Immutable versioned policies; approver must differ from author; one approved per kind+family; none exist in production | Any decision | Approve a minimal structural policy per family | Allow all three decisions, minimum 1 evidence item | **Yes** |
| G-D3 | Approve override policies (allowed scopes, optional maximum approval lifetime) | G5; TSH-08 | Two scopes only exist (`cancel_entry_before_selection`, `release_reserved_hold`); override requests need an approved override policy | Any override request | Approve both scopes; set a maximum lifetime | Approve both scopes, set an explicit short lifetime | **Yes** |
| G-D4 | Name who reviews and approves sponsor applications; decide whether sponsor-side submission needs an owner/manager role check at a future route | G6; TDP-01 §7 | Application lifecycle with independent platform reviewer, suspend/reinstate/final revoke, audit; DB blocks scheduling and NEW reservations without an approved sponsor; no route | Approving any real sponsor | Platform admins only; separate reviewer pool | Separate reviewer pool distinct from campaign administrators | **Yes** |
| G-D5 | Approve a fulfilment policy: collection verification mode and (optionally) the escalation age | G6 | Versioned immutable policy; interfaces return `available:false` with no approved policy; no SLA value exists in code | Collection policy and escalation reporting | `staff_confirmation` or `collection_code`; set an escalation age | Decide after the first pilot sponsor agrees collection terms | **Yes** |
| G-D6 | Approve and place the proposed permission keys (`shuffle:*`, `drops:*`); decide whether a cashier may ever hold `drops:fulfillment:verify` | TSH-01 §9; G6 | Definitions only (not in the catalogue, not granted, not on the cashier allow-list; unit-tested) | Any role grant, any new route authorization, any cashier fulfilment path | Add to catalogue now; add later with the first route | Add with the first approved route; cashier gets only `drops:fulfillment:verify` | n/a (nothing granted) |
| G-D7 | External sponsor analytics: approve the minimum group size, the sponsor permission and the route | TDP-04; G6 | Internal sponsor-scoped analytics with explicit threshold and all-or-nothing suppression; external access evaluates to a refusal | Any sponsor-facing analytics | Threshold ≥ campaign group size (D-6) | Use the stricter of the campaign and BCOMM thresholds | **Yes** |
| G-D8 | Approve notification class policies (campaign_invitation, allocation_notification, collection_reminder, operational, marketing): channels, template versions (`shuffle_invitation_v1` for invitations) and the marketing-consent source | G2; existing notification services | Persisted retry-safe synthetic delivery decisions; EMPTY policy registry ⇒ every intent HELD; consent never inferred | Any real campaign notification | In-app only first; email later with consent | In-app only for invitations; marketing only with explicit consent | **Yes** |
| G-D9 | Approve attribution policy (model, window), verified registration / verified referral definitions (D02/D04), advertising-spend evidence source and lifetime-value definition | G4; TSH-07; D02–D05 | Acquisition evidence counts what is already recorded; discovery, profile visits, Community interactions, verified referral/registration, attributed revenue, ROAS, LTV are `available:false` | Any ROAS / LTV / attribution figure | Approve definitions per D02–D05 | Settle D02–D05 first | **Yes** |
| G-D10 | CUST-DEL-03: name the privacy operator and approver; approve retention, legal-hold and anonymisation policies; review the deletion migration | D09, D12; G8 | Machine-checked customer-data inventory (41 entries, all `UNDECIDED_REQUIRES_OWNER_POLICY`); read-only readiness always `blocked` | Any customer-data deletion or anonymisation | Anonymise vs retain hashed evidence (D12) | Decide with D09 | **Yes** |
| G-D11 | BIZ-CLOSE-01: approve settlement/forfeiture/refund/retention (D08/D13) and how sponsored inventory, units awaiting collection and open cases are resolved on closure | D08, D13; G9 | Obligation counts and blockers include Tentaship items; processing stays blocked | Any business closure | Define with legal | Define with legal before processing | **Yes** |
| G-D12 | Whether the selection→allocation link needs a Shuffle-chain event | TSH-01 §8; G12 | Resolved in G12 (see FINAL_RELEASE_PREPARATION.md §G12): implemented as the smallest compliant correction | none | — | Closed | n/a |

## B. Legal register (L-1..L-6; unresolved, none approved)
| ID | Question | Draft prepared (unpublished) | Blocks |
|---|---|---|---|
| L-1 | Jurisdictions in scope | `tentaship-participation-terms` | Any participation |
| L-2 | Promotional-competition / lottery / gambling classification of Shuffle (no-purchase route, odds disclosure) | `tentaship-participation-terms`, `tentaship-free-route-statement` | Any Shuffle execution |
| L-3 | Consumer protection (disclosures, sponsor claims) | `tentaship-participation-terms`, `tentaship-sponsor-terms` | Any customer-facing release |
| L-4 | Terms, age eligibility, free-entry alternative | `tentaship-participation-terms`, `tentaship-free-route-statement` | Any invitation |
| L-5 | Privacy notice and marketing consent | `tentaship-privacy-supplement`, `tentaship-marketing-consent` | Any notification, any data use beyond current |
| L-6 | Tax and fulfilment responsibilities | `tentaship-sponsor-terms` | Any real sponsorship |
All drafts live in `docs/legal/tentaship/drafts/` (en, ar, es, fr), carry the unapproved banner and counsel placeholders, and are hashed in `BUNDLE.draft.json` (every publication and approval field is null; `node apps/api/scripts/tentaship-legal-bundle.mjs --check`). **LEGAL APPROVAL REQUIRED** before any text is shown to a user.

## C. Operational assignments (O-1..O-7 and new)
| ID | Assignment | Status |
|---|---|---|
| O-1 | Community accountability owner | OPERATIONAL ASSIGNMENT REQUIRED |
| O-2 | Community reviewers/moderators | OPERATIONAL ASSIGNMENT REQUIRED |
| O-3 | Support and incident handling | OPERATIONAL ASSIGNMENT REQUIRED |
| O-4 | Monitoring and alerting | OPERATIONAL ASSIGNMENT REQUIRED |
| O-5 | Retention schedule | OPERATIONAL ASSIGNMENT REQUIRED (links to G-D10) |
| O-6 | Disaster-recovery RPO/RTO | OPERATIONAL ASSIGNMENT REQUIRED |
| O-7 | Pilot cohort and owner | OPERATIONAL ASSIGNMENT REQUIRED |
| O-8 | Fraud investigators and dispute resolvers (G-D1) | OPERATIONAL ASSIGNMENT REQUIRED |
| O-9 | Policy authors and approvers (G-D2/G-D3/G-D5; two different people) | OPERATIONAL ASSIGNMENT REQUIRED |
| O-10 | Sponsor reviewers (G-D4) | OPERATIONAL ASSIGNMENT REQUIRED |
| O-11 | Named privacy operator and approver (G-D10) | OPERATIONAL ASSIGNMENT REQUIRED |
| O-12 | Collection-point staff process per sponsor (G-D5/G-D6) | OPERATIONAL ASSIGNMENT REQUIRED |

## D. Translation register
All new strings exist in en/ar/es/fr and key parity is tested; ONLY English is treated as canonical. Spanish, French and Arabic equivalence approvals (H-2, H-3, H-4) remain pending and cover: the Tentaship campaign card and Drops report (earlier), the G3 sponsor-application and governance-case components, the closure obligation/blocker labels added in G9, and all five legal drafts. No translation is marked approved (`translationApproval` is null in the bundle).

## E. What the Owner can decide in one pass
1. G-D1/G-D2/G-D3 + O-8/O-9 unlock governance for a synthetic-to-pilot rehearsal on staging.
2. G-D4/G-D5/G-D6 + O-10/O-12 unlock sponsor onboarding and a pilot fulfilment design.
3. L-1..L-6 unlock any customer-visible text; nothing customer-visible can go out before them.
4. G-D8/G-D9/G-D10/G-D11 are independent and can follow.
