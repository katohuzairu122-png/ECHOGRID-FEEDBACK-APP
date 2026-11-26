# R0 — Owner product rulings recorded (2026-11-26)

Documentation only. This record writes the Owner's rulings against the existing decision identifiers; it does not change code, configuration, data, infrastructure or any approval. **Approval of a product recommendation is not evidence that its operational or legal prerequisites are met, that the implementation is complete, that staging acceptance is done or that production is authorized.** Nothing here names a person, grants a permission, approves legal text or publishes anything.

## 0. Identifier families (kept distinct; no historical record is renamed)
| Series | Meaning | Authoritative record |
|---|---|---|
| G-D1…G-D11 (G-D12 closed) | Tentaship decisions arising from G1–G12 | `FINAL_CONSOLIDATED_REGISTERS.md` |
| L-1…L-6 | Tentaship legal requirements | same; `TSH_01_TDP_01…` |
| D-1…D-6 | Existing Tentaship rulings (outcome modes, transparency, reversals, group size) | `TSH_01_TDP_01…` §2 — not reopened |
| D01…D14 | Existing pending Tentaship product decisions | `DECISION_REGISTER_BATCH_03.md` |
| L1…L7, D1…D5, H-1…H-4, P-1, P-2 | **Community** legal artifacts, decisions, translation and release approvals | `NETWORK-15/FINAL/*` |
| O-1…O-7 | Community operations runbook (also govern shared platform operation) | `CF2_OPERATIONS_RUNBOOK.md` |
| O-8…O-12 | Tentaship-specific operational roles | `FINAL_CONSOLIDATED_REGISTERS.md` |

Status vocabulary: **APPROVED AND SATISFIED** · **APPROVED — IMPLEMENTATION REQUIRED** · **APPROVED — OPERATIONAL EVIDENCE PENDING** · **LEGAL APPROVAL REQUIRED** · **BLOCKED** · **NOT AUTHORIZED**. A row may carry several. "Implementation" status below was checked against `main` e940ddb.

## 1. Product rulings
| ID | Ruling recorded | Status | What exists / exact dependency |
|---|---|---|---|
| G-D1 | 2 fraud investigators + 2 dispute resolvers; nobody holds both roles; scope Shuffle and Drops; authorization expires after 90 days; renewal needs explicit authorization; revocation audited | **APPROVED — IMPLEMENTATION REQUIRED**; **APPROVED — OPERATIONAL EVIDENCE PENDING** (names) | Exists: scope `both`, optional expiry, final audited revocation, assigner ≠ assignee, a renewal is a new row that needs an explicit revoke of the expired one. **Gaps:** (a) expiry is optional and uncapped, so "90 days" is not enforced; (b) nothing prevents one person holding both roles at the same time (only per-case separation exists). Both need a small additive guard. Synthetic personas may be proposed for staging only; no production authority. |
| G-D2 | Allowed decisions `upheld, overturned, no_action`; ≥ 1 evidence item structurally required; a justification for each decision; author ≠ approver; immutable versions | **APPROVED — OPERATIONAL EVIDENCE PENDING** | Exists and tested: structural parameters, justification of at least 10 characters (database CHECK), author ≠ approver, immutable versions. One evidence item is a floor, not sufficiency; adequacy stays the reviewer's responsibility. Policy rows are not yet entered in production (needs named people). |
| G-D3 | Overrides `cancel_entry_before_selection`, `release_reserved_hold`; maximum approval lifetime 86,400 s; keep two-person authorization, evidence, expiry, audit | **APPROVED — OPERATIONAL EVIDENCE PENDING** | Exists and tested exactly as ruled. Production override policy (with `maxExpirySeconds` 86400) not yet entered. |
| G-D4 | 2 independent sponsor reviewers, distinct from submitters and from conflicting campaign administration; platform staff may submit on behalf of a business only through an approved, auditable process | **APPROVED — IMPLEMENTATION REQUIRED**; **APPROVED — OPERATIONAL EVIDENCE PENDING**; **NOT AUTHORIZED** (any real sponsorship) | Exists: reviewer ≠ submitter and platform-admin check (database), full audit, no route. **Gaps:** no approved submit-on-behalf process or route; no guard against a reviewer also administering the relevant campaigns. |
| G-D5 | `staff_confirmation`; proposed escalation 72 h, not activated until agreed collection terms exist for the sponsor; unavailable states preserved | **APPROVED — IMPLEMENTATION REQUIRED**; **APPROVED — OPERATIONAL EVIDENCE PENDING** | Exists: versioned policy with `staff_confirmation` and an optional escalation age; `available:false` without a policy. **Gaps:** the policy is global, so a 72 h value would apply to every sponsorship; and the collection step does not yet consult the policy. Until per-sponsor activation exists, approve the policy **without** an escalation age and add a 72 h version only when terms exist. |
| G-D6 | Introduce the eight proposed permissions only with their approved routes; a cashier may at most hold `drops:fulfillment:verify`, never granted automatically; no restoration of cashier administrative access; any cashier verification stays inside the restricted interface and credential boundary | **APPROVED AND SATISFIED** (current state) | Eight definitions exist in code only: not in the catalogue, not granted, not on the cashier allow-list (unit-tested). Future routes are a new authorized phase. |
| G-D7 | Aggregation threshold 10, or the campaign minimum if higher; keep all-or-nothing suppression; no identities or cross-business data; external sponsor analytics unavailable until permissions, routes and privacy approvals exist | **APPROVED — IMPLEMENTATION REQUIRED**; **NOT AUTHORIZED** (external analytics) | Exists: explicit threshold (minimum 2), all-or-nothing suppression, identity-free output, external access refuses. **Gap:** the floor of 10 and the "campaign minimum if higher" are not enforced; they must be when an external route is built. |
| G-D8 | In-app only; categories `campaign_invitation`, `allocation_notification`, `collection_reminder`; a separately reviewed, versioned template per category (no reuse of the invitation template); marketing only with explicit recorded consent; nothing real dispatched until privacy, template, routing and operational requirements are met | **APPROVED — IMPLEMENTATION REQUIRED**; **LEGAL APPROVAL REQUIRED** (L-5); **NOT AUTHORIZED** (real dispatch) | Exists: persisted retry-safe synthetic delivery decisions for invitations only; empty policy registry; consent never inferred. **Gaps:** no allocation or collection notification intents or templates; no per-category versioned template registry; no real in-app provider adapter. |
| G-D9 | Resolve D02–D05 using Batch 03; evidence-based reporting only; defer attribution windows, ad-spend attribution, ROAS, LTV | Deferrals **APPROVED AND SATISFIED**; D02–D05 itself **BLOCKED** until each is explicitly ruled | See §6. Deferred metrics are already `available:false`. |
| G-D10 | Separate privacy operator and approver; explicit authorization and separation of duties; approved retention schedule; documented legal-hold procedure; evidence minimisation; hashing does not by itself remove personal-data obligations; execution blocked | **APPROVED — IMPLEMENTATION REQUIRED** (execution design only); **APPROVED — OPERATIONAL EVIDENCE PENDING**; **LEGAL APPROVAL REQUIRED**; **BLOCKED**; **NOT AUTHORIZED** (any deletion or anonymisation) | Exists: complete data inventory, all `UNDECIDED_REQUIRES_OWNER_POLICY`; readiness always blocked. Treatment of hashed or anonymised evidence is a legal review item. |
| G-D11 | Fail-closed closure; no closure while any listed obligation is unresolved; no invented forfeiture, refund or settlement policy | Fail-closed **APPROVED AND SATISFIED**; **APPROVED — IMPLEMENTATION REQUIRED** (visibility); **BLOCKED**; **NOT AUTHORIZED** (any closure) | Processing is unconditionally blocked (policy not approved). Counted and blocking today: pending redemptions, customer points, open reward claims, subscriptions, cashier sessions, published Community posts, active sponsorships, uncollected units, open fraud/dispute cases. **Not yet counted:** outstanding settlements, financial liabilities, pending refunds, unresolved retention requirements. |

## 2. Legal requirements — all LEGAL APPROVAL REQUIRED
L-1 operating jurisdictions · L-2 Shuffle classification (promotional competition, lottery, gambling) · L-3 consumer protection · L-4 participation terms, age eligibility, free-entry alternative · L-5 privacy and marketing consent · L-6 tax and fulfilment responsibilities. Drafts exist only as unapproved skeletons (`docs/legal/tentaship/drafts/`); no draft is published or approved. **No real campaign selection, reward allocation, sponsorship execution or legally restricted activation is authorized.**

## 3. Operational structure (approved as the recommended structure; all names PENDING)
Every O-1…O-12 row is **APPROVED — OPERATIONAL EVIDENCE PENDING**. O-6 also **APPROVED — IMPLEMENTATION REQUIRED** (infrastructure, separate authorization; see §5).

### Staffing and responsibility matrix (no names, no assignments)
| Role | Runbook ID | Responsibility | Minimum |
|---|---|---|---|
| Accountable owner | O-1 | final accountability; policy approver of last resort | 1 |
| Release operator | O-1 | runs pinned protected workflows only; cannot grant legal or activation approval | 1 |
| Legal approver | O-2 | approves legal text | 1 (qualified counsel) |
| Language reviewers (en, fr, es, ar) | O-2 | equivalence review (H-1…H-4) | 1 per language |
| Support owner | O-3 | first-line handling, severity triage | 1 + deputy |
| Incident lead | O-3 | escalation owner between support and Owner | 1 + deputy |
| Backup owner | O-6 | backups, restore drills | 1 |
| Fraud investigators | O-8 | review fraud cases, request overrides | 2 |
| Dispute resolvers | O-8 | decide disputes, approve overrides | 2 |
| Policy authors / approvers | O-9 | author and approve decision, override and fulfilment policies | author ≠ approver |
| Sponsor reviewers | O-10 | review and approve sponsor applications | 2 |
| Privacy operator / privacy approver | O-11 | run and approve privacy operations | operator ≠ approver |
| Collection-point staff | O-12 | verify collections per sponsor | per sponsor |

**Conflicting combinations (enforced by the database unless marked "ruling"):** investigator + resolver (G-D1 ruling; per-case enforced, global holding not yet enforced) · opening a case + reviewing or deciding it · creating a campaign or sponsorship + deciding a case about it · requesting an override + approving it · authoring + approving the same policy · assigning an operator + being that operator · sponsor submitter + sponsor reviewer · privacy operator + privacy approver (G-D10 ruling) · release operator + legal approver (runbook) · sponsor reviewer + campaign administrator (G-D4 ruling).
**Recommended (not enforced):** sponsor reviewer should not also resolve disputes on that sponsor; support owner and incident lead should be different people; language reviewer and legal approver should differ.
**Compatible:** accountable owner may also be policy approver and privacy approver; release operator may also be policy author or backup owner; one person may hold several non-conflicting roles.
**Minimum staffing:** 4 distinct people exercise every separation rule in staging; a production set with full separation needs about 9 distinct people (owner, release operator, legal approver, support/incident, 2 investigators, 2 resolvers, 2 sponsor reviewers, privacy operator/approver where not overlapped), plus 4 language reviewers and collection-point staff. This count is derived from the rules above; the Owner may overlap non-conflicting roles. Production users must not be able to bypass these rules; no production operator is assigned.

## 4. Translation (H-1…H-4 remain PENDING)
English, French, Spanish and Arabic interface strings remain as implemented. Legal text requires English legal approval (H-1) then French (H-2), Spanish (H-3) and Arabic (H-4, including reading order, numbers and dates) equivalence reviews with the legal owner before any translated legal text is published. Mode B wording remains unavailable until approved.

## 5. O-6 — recovery targets approved for feasibility assessment
Targets: production **RPO ≤ 1 h**, **RTO ≤ 4 h**, **PITR retention 7 days**, **automated backups daily**, **backup retention 30 days**, **verified pre-release restore points mandatory**. These are targets for assessment; nothing has been changed, upgraded or purchased. Facts and findings are in `R1_INFRASTRUCTURE_PREFLIGHT_2026-11-26.md` §6; the definitions are kept apart there (PITR retention ≠ RPO ≠ RTO ≠ backup frequency ≠ backup retention).

## 6. D02–D05 reconciliation against Batch 03 (G-D9)
The Owner directed that D02–D05 be resolved against `DECISION_REGISTER_BATCH_03.md`. That register's recommendations are restated here; **no individual D02–D05 ruling has been given yet, so none is recorded as approved**.
| ID | Question | Batch 03 recommendation | Owner ruling |
|---|---|---|---|
| D02 | Final verified-referral definition | approve the proposed definition with an Owner-set window | PENDING |
| D03 | Qualifying purchase definition, thresholds, currencies | per approved rule and currency | PENDING |
| D04 | The referral qualifying event | first qualifying purchase after attribution | PENDING |
| D05 | Purchase evidence level required | do not treat recorded purchases as paid; record the evidence level used | PENDING |

## 7. Decision-dependent implementation (nothing started)
1. Governance guards: mandatory 90-day expiry and "not both roles" (G-D1).
2. Sponsor submit-on-behalf process and route, plus reviewer-independence guard (G-D4).
3. Fulfilment policy wired into collection, with per-sponsor activation of escalation (G-D5).
4. Permission catalogue and role integration, introduced route by route (G-D6).
5. Sponsor-facing analytics route with the threshold floor of 10 / campaign minimum (G-D7).
6. Allocation and collection notification intents, per-category versioned templates, in-app provider (G-D8).
7. Attribution calculations once D02–D05 are ruled and definitions approved (G-D9).
8. Deletion execution design after legal and named operators (G-D10).
9. Closure obligations extended to settlements, liabilities, refunds and retention, then processing design (G-D11).
No requirement already satisfied is reopened.

## 8. Supersession note
The Community record P-1 ("Authorize staging migration 0088–0090") is superseded for the Tentaship release by the refreshed staging scope **0088–0106 (19 migrations)** in `R1_INFRASTRUCTURE_PREFLIGHT_2026-11-26.md` §8. P-1, P-2 and all other historical records are unchanged.
