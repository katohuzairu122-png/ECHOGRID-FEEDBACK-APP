# BDPN D-18 v1.1 — Group G0: owner decision reconciliation

Status: **DOCUMENTATION ONLY. PROPOSED — OWNER APPROVAL PENDING.** Nothing here is approved, in force, or authorizes runtime work.
Authoritative main when written: `ef967a64949aed314ef5817fd8702a0c0203ac36` (2026-11-15). Reported main `41b517ce` is an ancestor of it.
Companions: `BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md` (register OD-1..OD-28, section 13), `BDPN_D18_V1_1_RECONCILIATION_AUDIT.md` (conflicts C-1..C-15),
`BDPN_D18_V11_OWNER_POLICY_LOCK.md`, `BDPN_D18_V11_GROUPED_DEVELOPMENT_PLAN.md`, `BDPN_D18_V11_CONTRACTS_AND_ACCEPTANCE.md`.

## 1. Verified starting state

| Fact | Evidence |
| --- | --- |
| #440 (owner policy lock, three files) is merged | PR #440 merged 2026-11-15 by the owner |
| #441 (audit and amendment proposal) is merged | PR #441 merged 2026-11-15 by the owner |
| The amendment is a proposal, not in force | Amendment section 14: needs independent review and the owner's recorded approval |
| No BDPN feature code exists on main | Audit; no BDPN commits since #441 touch code |
| No OD has been approved since #441 | Search of `docs/` finds OD-n only in the audit and amendment; the owner decision record (D-1..D-24) is unchanged. D-24 is still "DECIDED, follow-up open" |
| Existing locks preserved | D-18 (informational join text), D-19 (one migration), D-24, CUSTOMER-AUTH CA-06/07/08, Split 01 invariant 4 stay in force until an amendment is approved |

## 2. Tier 1 — proposed owner rulings (PROPOSED — OWNER APPROVAL PENDING)

Each is a recommendation recorded for the owner. None is approved. Each lists what it would change **only after** approval.

### OD-1 — Business visibility (replaces the plan-gated part of D-24)
- **Proposed ruling:** every active, approved, published business is discoverable regardless of subscription. Remote enrollment and Community promotion are
  separately entitled; discovery is never a plan feature.
- **On approval, amends:** `BDPN_01_OWNER_DECISION_RECORD.md` D-24 (visibility no longer plan-gated; plan gating moves to the two new entitlements) and the reserved plan
  term in `BDPN_01A` section 6. Closes C-1 and R-6.
- **Dependencies/risks:** none technical. Economic effect (less upgrade pressure for visibility) is the owner's call. Does not change publication or moderation.

### OD-18 — "Participating business"
- **Proposed ruling:** a participating business is an active business with an approved, published profile. Subscription status is **not** part of discovery eligibility.
- **Open implementation detail (not decided here):** the repository meaning of "active" (business status values) must be read from the schema in block P/E0 before wording is
  frozen. This document does not assume one.
- **On approval:** the same definition is used by OD-1, the entitlement evaluator, and the discovery read model.

### OD-17 — Authorized remote-enrollment context (Split 01 / Split 03)
- **Proposed ruling:** an approved published business profile, a valid `loyalty.remote_enrollment` entitlement and explicit business opt-in together count as an
  **additional** authorized business context for joining. The physical branch QR remains valid and unchanged.
- **Conditions that must travel with it:** explicit versioned customer consent; applicable program terms disclosed; tenant isolation; no purchase-evidence bypass; no automatic
  points; independent security review (block B5) before any code.
- **On approval, amends:** Split 01 hard invariant 4 and Split 03 section 4 (only after approval); closes C-10, and informs C-3, C-4, C-15.
- **Not answered by this ruling:** OD-21 (messaging reach), OD-23 (survey audience), OD-11 (branch context), OD-22 (audit). B5 stays blocked on them.

### OD-14 — Entitlement authority
- **Proposed ruling:** a separately versioned **entitlement specification** (new document, owner to choose its location and name). It must require:
  1. read-only entitlement evaluation;
  2. one authoritative source for subscription state and plan features;
  3. default-deny for missing, unknown, expired or invalid entitlements;
  4. an explicit grant/revocation authority;
  5. auditable administrative changes (who, when, previous and new value);
  6. no reliance on a Split 08 entitlement specification (none exists; C-6).
- **Known hazard to specify:** the platform plan PATCH and `reconcileCatalog` can rewrite plan features (amendment section 8.1); the specification must say who may change them.
- **On approval:** closes C-6, R-7; unblocks E0 together with OD-2, OD-3, OD-4, OD-5.

### OD-24 — Migration governance (amends D-19 and BDPN-01E M1)
- **Proposed ruling:** replace "ship BDPN as one new migration" with: independently authorized, versioned migrations per development block, preserving migration ordering,
  rollback planning, environment separation and per-migration approval gates. Existing governance (`docs/MIGRATION-GOVERNANCE.md`, journal guard) applies to each.
- **Note:** D-19's other half (apply the existing backlog first) is not changed by this ruling.
- **On approval:** closes C-14; permits B3/B4 schema (interest storage; notification CHECK change) as separate migrations, each still needing its own authorization.

## 3. Decision register status (OD-1..OD-28)

Status values: **PROPOSED** (Tier 1 recommendation, approval pending), **ADDRESSED BY LOCK** (the owner lock answers or narrows it; confirmation requested, not a final ruling),
**OPEN**. No decision is RESOLVED. Block = the first block that needs the answer (amendment section 11).

### G0 / P (visibility, vocabulary, contracts, migration rule)
| ID | Decision | Status | Block | Flag |
| --- | --- | --- | --- | --- |
| OD-1 | D-24 replaced for discoverability | PROPOSED (Tier 1) | G0/P | |
| OD-13 | Split 09 reliance on "discoverable" (D-23 stays deferred) | OPEN (follows OD-1/OD-18) | G0 | |
| OD-18 | Meaning of "participating" | PROPOSED (Tier 1) | G0/P | |
| OD-24 | Amend single-migration rule | PROPOSED (Tier 1) | G0 (first used by B4) | |
| OD-27 | Path namespace `/discovery/...` or `/community/businesses/...` | OPEN | G0 (before any endpoint) | |

### E0 — entitlement authority and plan eligibility
| ID | Decision | Status | Flag |
| --- | --- | --- | --- |
| OD-14 | Entitlement authority specification | PROPOSED (Tier 1) | |
| OD-2 | Which plans include each entitlement; bundling (no invented names or prices) | OPEN (economic) | |
| OD-3 | Which subscription statuses count as entitled (`active`, `trialing`, `past_due` grace?) | OPEN | **Security/privacy assessment** (payment-state disclosure, T-3) |
| OD-4 | Behaviour on downgrade/cancel (Join disappears, members stay, interest kept, promotions hidden not deleted) | OPEN (lock invariant 9 and matrix point the same way; not yet confirmed as a ruling) | |
| OD-5 | Stored key spellings and permission keys (labels are design labels; `business.discovery` never a plan feature) | OPEN | |
| OD-20 | `mode` discloses entitlement state; lapse signal; `past_due` grace | OPEN (depends on OD-3) | Privacy (T-3) |

### B2 — business settings and readiness
| ID | Decision | Status | Flag |
| --- | --- | --- | --- |
| OD-6 | Definition of "loyalty program available" for remote enrollment | OPEN | |
| OD-19 | Opt-in persistence after an entitlement lapse and return | OPEN | |

### B3 / B4 — enrollment interest, aggregation and privacy
| ID | Decision | Status | Flag |
| --- | --- | --- | --- |
| OD-7 | Interest limits (active interests, cooldown, expiry, remote-join daily cap) | OPEN | |
| OD-8 | Digest threshold K, frequency, recipients, permission | OPEN | |
| OD-10 | Tell an interested customer when Join starts (needs event and opt-in) | OPEN; out of scope unless chosen | |
| OD-25 | Reuse NETWORK `network_follows` for interest | OPEN | |
| OD-28 | K=5 distinct customers, weekly digest, non-overlapping windows | OPEN (the lock proposes ">=5 in 7 days", daily digest "to decide"; the amendment proposes weekly) | **Privacy assessment** (differencing, T-4) |

### B5 — remote enrollment, consent, messaging and audit
| ID | Decision | Status | Flag |
| --- | --- | --- | --- |
| OD-17 | Authorized enrollment context | PROPOSED (Tier 1) | Security review (B5) |
| OD-9 | Remote-path notice wording; counsel review | OPEN (structure answered by lock: versioned consent plus current terms; wording/legal open) | Consent |
| OD-11 | Branch context for remote enrollment | OPEN | |
| OD-12 | Remote enrollment awards nothing automatically | **ADDRESSED BY LOCK** (see below); confirmation requested | |
| OD-21 | Messaging reach of remotely joined members | OPEN | **Security, consent and privacy assessment** (T-18) |
| OD-22 | Storage and readers of customer-attributed join/refusal audit records | OPEN | |

### B6 / B7 — community promotions and surveys
| ID | Decision | Status | Flag |
| --- | --- | --- | --- |
| OD-15 | v1 promotion scope (`business_post`, display-only discounts); moderation staffing | OPEN | Content policy |
| OD-16 | Eligibility display rule for promoted surveys; "eligible surveys" read | OPEN | |
| OD-23 | Exclude remotely joined members from `business_member` survey audience until a first visit | OPEN | **Security, consent and privacy assessment** (T-19) |
| OD-26 | May plan-gated promotions precede NETWORK-05 / BDPN-05 | OPEN | |

### OD-12 reconciliation (no duplicate decision created)
The owner lock already states: remote join "must not bypass purchase evidence" (invariant 4) and "never assume remote join awards points" (locked constraints); invariant 9 excludes
backfill, partner credits, settlement and billing effects. The amendment (section 2A) records OD-12 as "answered". Because the lock is "owner product direction locked for design" and
not a recorded ruling on register entry OD-12, this document sets OD-12 to **ADDRESSED BY LOCK — confirmation requested**, not RESOLVED. Approving it needs one line from the owner
("OD-12 confirmed: remote enrollment awards no points and bypasses no purchase evidence"). Only the register row changes; no new decision ID is created.

### Flags requiring additional security, consent and privacy assessment before any related block
**OD-3** (payment-state disclosure), **OD-21** (outbound channel without presence), **OD-23** (presence-free survey eligibility), **OD-28** (aggregate differencing). Each needs a written
assessment attached to its approval before the owning block is authorized.

## 4. Conflicts C-1..C-15 — reconciliation status

None is closed in the repository yet; "closes on" says which approved ruling closes it.

| C | Subject | State | Closes on |
| --- | --- | --- | --- |
| C-1 | Decision 1 vs D-24 | Open, ruling proposed | OD-1 |
| C-2 | Interest vs BDPN-01C/01D non-effects, D-17 | Open, resolved in amendment text | Approval of the amendment |
| C-3 | Remote join vs D-18 / BDPN-01C | Open, resolved in amendment text | Approval of the amendment; OD-17 |
| C-4 | BDPN-01D "no loyalty read or write" | Open, resolved by routing through the membership service | Approval of the amendment |
| C-5 | Survey discovery vs BDPN-01D H2 | Open, resolved in amendment text | Approval; OD-16 |
| C-6 | "Split 08 entitlement authority" does not exist | Open, ruling proposed | OD-14 |
| C-7 | QR join has no program-enabled/branch check | Open; QR path not changed | OD-6 |
| C-8 | NETWORK N-06 plus promotion entitlement | Open, combined predicate stated | Approval; OD-26 |
| C-9 | CA-08 consent wording and versioning | Open | OD-9 |
| C-10 | Split 01 invariant 4 / Split 03 section 4 | Open, ruling proposed | OD-17 |
| C-11 | BDPN-01C read-only and closed DTO | Open, resolved in amendment text | Approval of the amendment |
| C-12 | BDPN-01D, D-17, 01E T-14 customer-handle pairing | Open, resolved in amendment text | Approval; OD-22 |
| C-13 | NETWORK isolation, `network_follows`, phasing, BDPN v1.0 lock | Open | OD-25, OD-26 |
| C-14 | D-19 / 01E M1 single migration | Open, ruling proposed | OD-24 |
| C-15 | Program terms vs instant join | Open | OD-9 |

## 5. Group G0 approval checklist (all unchecked: nothing is approved)

- [ ] Owner confirms the Tier 1 rulings: OD-1, OD-18, OD-17, OD-14, OD-24 (each approve / amend / reject, recorded as a new version of the BDPN decision record).
- [ ] Owner confirms or amends OD-12 (one line).
- [ ] Owner decides OD-27 (path namespace) and OD-13 (Split 09 reliance).
- [ ] The amendment (`BDPN_D18_V1_1_AMENDMENT_AND_DESIGN.md`) receives an independent review that is not by its author. The review so far was a model session, not a human review; the owner says whether a human reviews.
- [ ] Owner approves the amendment text, recorded as a new version of the BDPN decision record (D-18, D-24 and D-19 entries updated; Split 01/03 amended only if OD-17 is approved).
- [ ] Written security/consent/privacy assessments exist for OD-3, OD-21, OD-23, OD-28 before their blocks.
- [ ] Owner authorizes E0 separately (needs OD-2, OD-3, OD-4, OD-5, OD-14).
- [ ] Prerequisite P (BDPN-01 implementation, D-16 content policy, D-19 backlog) is scheduled or consciously deferred.

## 6. Sequencing (unchanged by this document)

`G0 -> E0 -> B2`. B3/B4 only when their contracts and decisions (OD-7, OD-8, OD-24, OD-25, OD-28) are resolved. **B5 is blocked** until OD-17, OD-9, OD-11, OD-12, OD-21, OD-22, the consent
wording, the security review and the prerequisite gates are approved. B6/B7 are separately gated (OD-15, OD-16, OD-23, OD-26). The lock's group names (G1..G5) map to the amendment's
blocks as in amendment section 2A. No block advances automatically; each needs its own authorization and ends with a completion report.

## 7. Non-authorization

No runtime code, migration, deployment, infrastructure or secret change, notification, financial activation, PLATFORM-IDENTITY-01, or PR merge is authorized by this document.
QR security, tenant isolation, consent and loyalty ledger invariants are unchanged.
