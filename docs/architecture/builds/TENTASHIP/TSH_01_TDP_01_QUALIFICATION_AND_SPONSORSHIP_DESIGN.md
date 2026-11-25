# TSH-01 + TDP-01 — Tentaship Shuffle qualification architecture and Tentaship Drops sponsorship architecture (consolidated design)

Status: DESIGN ONLY — no runtime code, schema, migration, route or activation. Authority: Owner directive 2026-11-25 (§8). Baseline: main `1af1d5b`. Production activation of any randomized campaign: **NOT AUTHORIZED**.

## 1. Scope

In scope: domain model, qualification rules, lifecycles, data-model and API proposals, authorization, feature controls, threat model, acceptance specifications, dependency reconciliation. Out of scope: runtime Shuffle or reward allocation, schema changes, migrations, deployment, activation. All table and route names below are **proposals**.

## 2. Owner rulings that bind this design

- **D-3 outcome policy:** two campaign modes. **Mode A — guaranteed:** every admitted participant receives an eligible sponsored reward, subject to inventory reservation. **Mode B — limited:** eligible participants may outnumber rewards; some receive none. The mode is disclosed before acceptance and **cannot change** after any participant has accepted the rules (the rule version is immutable; a change requires a new campaign version and fresh acceptance). Neither mode may be activated in production without legal approval.
- **D-4 transparency:** before acceptance show the allocation mechanism, relevant variables and when the final determination happens; show an exact probability only when it is determinable, otherwise state the method and variables (remaining inventory, final participant count). No fixed odds that can be false, no sold-out reward shown as obtainable, animation never implies likelihood.
- **D-5 reversals:** before allocation, recalculate eligibility, invalidate affected invitations/entries, record reason and evidence, notify where required. After allocation, no silent revocation; only an approved dispute/fraud process with recorded authorization. After collection, no automatic debt or liability; recovery needs a separately approved legal/operational policy.
- **D-6 group size:** never hardcoded. Per campaign: minimum participants, maximum capacity, qualification window, entry-acceptance deadline, inventory-dependent limits, closure and cancellation conditions; validated against inventory, mode, system capacity and law.
- **D-1/D-2:** badges come from the separate achievement ledger (TB-01); legacy Community Points never convert into entries or qualification units without a separately approved policy.
- Residual ambiguity (recorded, not assumed): D-6 does not set the minimum group size used to suppress small-group _analytics_ (BCOMM-02); that remains a separate decision.

## 3. Domain model (proposed)

| Entity                         | Purpose                                           | Key properties                                                                                                         |
| ------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `campaign`                     | Shuffle campaign shell                            | mode (A/B), jurisdictions, status, owner, current rule version                                                         |
| `campaign_rule_version`        | **Immutable** published rules                     | qualification spec, limits (D-6), terms version, disclosure text hash, content hash                                    |
| `qualification_contribution`   | A recorded contribution event                     | participant ref, type (referral, purchase, cross-business, badge, acquisition, retention), source evidence ref, status |
| `qualification`                | Result of evaluating a rule version               | participant, rule version, pathway(s) met, evidence set, validity window, status                                       |
| `invitation`                   | Offer to take part                                | qualification ref (unique), status, expiry, notification refs                                                          |
| `entry`                        | Accepted participation                            | invitation (unique), acceptance record (terms hash), eligibility snapshot ref, status                                  |
| `eligibility_snapshot`         | Immutable record of who was eligible at admission | entry, evidence hashes, evaluated-at, rule version                                                                     |
| `drop` / `drop_inventory_unit` | Sponsored product and its units (TDP)             | see §7                                                                                                                 |
| `allocation`                   | Server outcome for an entry                       | entry (unique), result (reward / none), unit ref, randomness evidence, recorded-at                                     |
| `allocation_event`             | Append-only audit of every state change           | actor, authorization, reason, prior hash                                                                               |
| `dispute` / `fraud_case`       | Investigation records                             | subject, evidence, decision, approver                                                                                  |

Participant is a polymorphic reference `{type: customer|business, id}`; business-specific rules are scoped by tenant, platform-wide rules by network scope, and campaign-specific rules by campaign id.

## 4. Qualification rule engine

- Rules are **declarative data validated against a closed schema** (JSON Schema + server-side validator). No expressions, scripts, regular expressions from administrators or user-supplied code.
- A rule = `{ pathways: [...], combinator, window, expiry }`. A **pathway** = `{ participantType, scope(platform|business|campaign), metric, threshold, evidenceKind, validityDays }`.
- Metrics (closed enum): `verified_customer_referrals`, `verified_business_referrals`, `qualifying_purchases_at_business`, `distinct_businesses_with_qualifying_purchases`, `badge_awarded(definitionId)`, `verified_customers_acquired`, `customer_retention_rate`, `business_achievement(definitionId)`. Thresholds are configuration, e.g. 100 referrals or 300 customers are illustrative examples only.
- **Combinators (approved set):** `ANY` (OR over pathways), `ALL` (AND), and `AT_LEAST(n)` of m pathways. No nesting beyond one level without a new design review. The combinator is part of the immutable rule version.
- Evaluation is a pure function of (rule version, evidence set, evaluation time): deterministic, idempotent, replayable from stored evidence. Validity and expiry are explicit; reversal triggers re-evaluation (D-5).
- Customer and business participants, platform-wide vs business-specific vs campaign-specific qualification, evidence, validity, expiration and reversal are separate fields — none inferred.

## 5. Referral and purchase integrity

Findings from the repository: `loyalty_accounts.referred_by_customer_id` and `referral_bonus` are business-scoped, unverified, un-reversible and tied to a business loyalty account; they do **not** equal network-level referral attribution and must not be reused as qualification evidence as-is. Reusable: customer identity (verified email/phone state), the transaction ledger, deletion and pilot guards.

Definitions (proposed, need Owner approval):

- **Verified referral:** a referral record linking referrer→referred created from a one-time referral token, where the referred party completed verified account creation (verified email or phone) **and** satisfied a defined activation condition (e.g. first verified visit or qualifying purchase), is a distinct person per identity checks, and the record has not been reversed.
- **Qualifying purchase:** a completed, non-refunded, non-reversed transaction recorded by an authorized cashier/business flow at a business in good standing, above a configured minimum, past a configured settlement/refund window, not made by the referrer/business owner/staff account for itself.
- Unverified account creation never counts. Refunds, reversals and cancellations remove the contribution (D-5 before allocation). Account deletion: contribution evidence is retained in anonymized/hashed form only as required for fraud and legal holds (aligned with CUST-DEL-03 policy, open).
- Defences: self-referral (same identity/device/payment-token signals, minimal data), duplicate accounts (existing uniqueness + verified contact), fabricated businesses (business verification state + minimum age/activity), circular schemes (graph cycle detection on referral edges), automated creation (existing rate limits + verification), fabricated/refunded purchases (settlement window, cross-check with cashier audit trail), repeated milestone claims (unique evidence per qualification), cross-tenant leaks (all evidence reads tenant-scoped). No new personal data collection beyond existing verified identifiers.

## 6. Lifecycle and state machine (qualification → acquisition)

Participant-facing flow: contribution recorded → verified → qualification evaluated → qualified → invitation generated → notified → rules reviewed → acceptance → eligibility revalidated → entry admitted → allocation → outcome revealed → collection → fulfillment verified → acquisition measured.

Explicit states and transitions (terminal in bold):

- Contribution: `recorded → verified | rejected`; `verified → reversed`.
- Qualification: `evaluating → qualified | not_qualified`; `qualified → invalidated | expired | consumed`.
- Invitation: `generated → notified → viewed → accepted | declined | expired | withdrawn (invalidated qualification)`.
- Entry: `accepted → revalidating → admitted | rejected`; `admitted → allocated | unallocated(Mode B, none) | cancelled(campaign cancelled)`.
- Allocation: `pending → reserved → awarded → revealed → collected | expired`; `awarded → disputed → upheld | overturned` (only via authorized process, D-5).

Guarantees: one invitation and one entry per qualification event (unique constraints); acceptance records the exact rule-version and terms hash; revalidation at admission and again immediately before allocation; notification is informational only and **never** authorizes anything — every step re-checks Community membership, enrollment/restoration state, consent, account and business status, jurisdiction, campaign status and eligibility restrictions server-side.

## 7. Tentaship Drops — sponsorship architecture (TDP-01)

A sponsoring business defines: product/service identity, description, image, quantity, eligible participant type, collection location/method/window, expiration, availability restrictions, variation rules, fulfillment responsibilities, published collection conditions and campaign association.

**Two separate status machines (never one overloaded field):**

- **Sponsorship (drop) status:** `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → SCHEDULED → AVAILABLE`; side states `SUSPENDED`, `CANCELLED`, `EXPIRED`. Review is by a platform reviewer, not the sponsor.
- **Allocation (unit) status:** `AVAILABLE → RESERVED → ALLOCATED → COLLECTED`; `RESERVED → AVAILABLE` (release on timeout/failure); `ALLOCATED → EXPIRED` (collection window passes); `ALLOCATED → VOID` only via the dispute/fraud process.
- The requested single list (DRAFT…CANCELLED) is split accordingly: `RESERVED, ALLOCATED, COLLECTED` belong to the unit/allocation machine; `EXPIRED` exists on both with distinct meanings (offer expiry vs uncollected reward).

Rules: once a unit is `ALLOCATED` the sponsor **cannot** withdraw or reduce it; suspension/cancellation of a sponsorship stops _new_ reservations but allocated units stay honoured or follow a recorded, authorized remedy. Sponsor-initiated cancellation before allocation is allowed; after, it creates a dispute record. "Free" is displayed only when no mandatory payment applies; any purchase condition must be disclosed and legally approved before activation, and subsequent purchases are ordinarily voluntary.

**Inventory reservation semantics (design):** inventory is stored as individual units or a counted pool with a single authoritative row per drop; reservation uses a single transaction with `SELECT … FOR UPDATE SKIP LOCKED` (units) or a guarded `UPDATE … SET reserved = reserved + 1 WHERE available > 0` (pool) returning the row; a unique `(entry_id)` constraint on allocation prevents double reservation; reservations carry an expiry and a release job returns units; exhaustion returns a typed `INVENTORY_EXHAUSTED` outcome handled per mode (Mode A: entry is held pending replenishment or cancelled with disclosed remedy; Mode B: `unallocated`). Over-allocation is prevented by the database constraint (`reserved + allocated + collected <= total`), not by application logic alone.

## 8. Allocation and randomization (design for TSH-04)

- Server-authoritative: the client only requests participation and later reads the recorded outcome. The animation **reveals** a stored result; it never determines it.
- Randomness: CSPRNG on the server (Web Crypto) drawn at allocation time; for Mode B draw uniformly without bias from the eligible-entry set using rejection sampling; the draw seed/derivation, rule version, snapshot hash and inventory state hash are stored as allocation evidence.
- Auditable and tamper-evident: `allocation_event` rows form an append-only hash chain (each row stores the previous hash); no UPDATE/DELETE grants for the application role; corrections are new compensating events with authorization.
- Idempotent participation (idempotency key + unique entry per qualification), replay protection (single-use signed participation tokens, short expiry), concurrent-request safety (row locks as in §7), duplicate-entry prevention (unique constraints).
- Campaign suspension halts new invitations/entries/allocations immediately; controlled cancellation records reason, notifies affected participants and handles reserved units.
- Sponsors cannot choose winners; administrators cannot rewrite recorded allocations.

## 9. Authorization and separation of duties

Separate permissions (proposed keys): `shuffle:campaign:administer`, `drops:sponsorship:approve`, `drops:inventory:manage` (sponsor, own drops only), `shuffle:qualification:verify`, `shuffle:fraud:investigate`, `shuffle:dispute:resolve`, `shuffle:campaign:suspend`, `drops:fulfillment:verify` (business staff at the collection point; cashiers get **only** the fulfillment verification permission, never owner/manager permissions). Separation of duties: the sponsor cannot approve its own sponsorship; a campaign administrator cannot resolve disputes on that campaign; the fraud investigator and the dispute approver are different people; allocation-affecting overrides need two-person approval. All platform-admin actions are reauthenticated and audit-logged; reads are tenant-scoped (sponsors see only their drops and aggregate acquisition outcomes, never other businesses' customers).

## 10. Independent feature controls (design)

`TENTASHIP_BADGES_ENABLED`, `TENTASHIP_SHUFFLE_ENABLED`, `TENTASHIP_DROPS_ENABLED`: absent or any value other than exact `true` = off; evaluated server-side on every route and job (the web UI only reflects status); verified **not** present in code or Wrangler config on main. They never reuse or imply `NETWORK_FEED_ENABLED`, and each additionally requires Community enrollment, membership, restoration and consent checks. Activation dependencies: Shuffle requires Badges' qualification evidence interfaces and Drops inventory; Drops requires legal approval of terms; none may be enabled without the L-1..L-6 approvals. Suspension: flag off stops new activity, keeps **read-only** historical access for participants and auditors, keeps already allocated rewards collectible (or applies the approved remedy), and halts the reservation-release job only after releasing held units. Safe failure: any error reading a control, rule or evidence = fail closed (no invitation, no entry, no allocation). Emergency containment: flag removal plus per-campaign `SUSPENDED` state, both effective on the next request.

## 11. Acquisition attribution (TDP/TSH-07 input)

Events (where legally permitted and consented): qualification, invitation, acceptance, participation, allocation, collection, first verified visit, first qualifying purchase, subsequent purchases, retention. Attribution links participant→sponsor only through the allocation record and a collection verification at that business; it does not enroll the participant in the sponsor's loyalty program, grant marketing consent, or expose other businesses' records. Sponsors see aggregates (with a suppression threshold to be decided, §2 residual) and their own collection records, nothing else.

## 12. Threat model (summary)

| Threat                               | Mitigation                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| Sponsor or admin manipulates winners | Server CSPRNG, evidence + hash chain, no write path to results, separation of duties |
| Double claim / race on last unit     | DB constraints, row locking, unique entry per qualification                          |
| Fabricated referrals/purchases       | Verified-definition, settlement window, cashier audit cross-check, cycle detection   |
| Replay of participation request      | Single-use signed tokens, idempotency keys                                           |
| Cross-tenant data exposure           | Tenant-scoped queries and aggregate-only sponsor views, authorization tests          |
| Purchase-to-enter or staking         | No payment, no points or badge stake path; code-level absence tested                 |
| Misleading odds/availability         | Disclosure fields in the immutable rule version, UI renders only recorded values     |
| Deletion/closure conflicts           | Anonymization rules, closure rules before activation                                 |
| Insider rewriting history            | Append-only roles, chain verification job                                            |

## 13. Proposed API contracts (illustrative, not implemented)

Participant: `GET /shuffle/invitations`, `POST /shuffle/invitations/:id/accept` (idempotency key, terms hash), `POST /shuffle/entries/:id/participate`, `GET /shuffle/allocations/:id` (read-only recorded outcome). Business sponsor: `POST /drops`, `POST /drops/:id/submit`, `GET /drops/:id/acquisition-summary`. Platform: `POST /platform/campaigns`, `POST /platform/campaigns/:id/versions`, `POST /platform/drops/:id/approve`, `POST /platform/campaigns/:id/suspend`, fraud/dispute endpoints. All gated by the controls above, authenticated, tenant-scoped, rate limited, returning `Cache-Control: no-store`.

## 14. Acceptance specifications (for TSH-09/TDP-04)

1. Control off ⇒ every route/job refuses and nothing is created. 2. Rule versions are immutable after first acceptance. 3. Evaluation is deterministic and idempotent for the same evidence. 4. No second invitation/entry for one qualification event. 5. Concurrent participation on the last unit never over-allocates (property test, N parallel clients, PG16 and PG18). 6. Allocation is reproducible from stored evidence and the chain verifies; tampering is detected. 7. The client cannot influence the outcome (no outcome in any request payload). 8. Sponsor cannot withdraw allocated units. 9. Reversal before allocation removes the entry and notifies; after allocation it creates a dispute and never silently revokes. 10. Cashier and manager permission boundaries hold; tenants cannot read each other. 11. Disclosure text hashed in the rule version matches what the participant accepted. 12. Deletion/closure interactions behave per the approved policy. 13. Browser acceptance (desktop/mobile, four languages incl. Arabic RTL) shows recorded outcomes only.

## 15. Dependencies and open decisions

Depends on: TB-01 decisions (done), referral definitions (Owner approval, §5), Community readiness and activation controls, CUST-DEL-03 operator policy (deletion semantics), BIZ-CLOSE-01 (closure), legal L-1..L-6, operational owners (fraud, disputes, fulfillment SLAs, suspension authority), domain/trademark status. Open: verified-referral and qualifying-purchase definitions (§5), Mode B no-reward communication wording, minimum aggregate group size, retention periods, sponsor obligations and remedies. Nothing in this document is legal advice or a legal clearance; a free reward or free entry does not by itself resolve lottery or gambling classification, and purchase-based qualification needs a jurisdiction-specific assessment.
