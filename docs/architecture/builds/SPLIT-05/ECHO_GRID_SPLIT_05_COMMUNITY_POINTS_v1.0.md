# ECHO GRID — SPLIT 05: COMMUNITY POINTS

**Status:** FROZEN FOR IMPLEMENTATION  
**Version:** v1.0  
**Architecture class:** Community / Participation / Rewards  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Target branch:** `main`  
**Implementation branch:** `architecture/split-05-community-points`  
**Depends on:** Splits 01–04 LOCKED COMPLETE  
**Expected migration:** `0038_split05_community_points.sql`

---

## 1. Authority

This specification must be read together with:

- `ECHO-GRID-LOYALTY-PROGRAM-ARCHITECTURE-v1.0.0-LOCKED.md`;
- Split 01 — Identity / Customer Relationships;
- Split 02 — Business / Branch;
- Split 03 — Loyalty / Core QR;
- Split 04 — Surveys / Participation.

Locked upstream rules preserved here:

1. Community Points are a separate Echo Grid platform system.
2. Community Points are not a business primary loyalty program.
3. Community Points require their own ledger.
4. Community Points must never be merged into business loyalty balances.
5. Community Points are non-cash reward units.
6. Community Points, Business Loyalty, Orphan Reward Claims, Partner Credits, and Subscription Billing remain separate financial domains.
7. Customers retain one global Echo Grid identity.
8. Businesses must not silently enroll customers into the Echo Grid Community.
9. Verified participation evidence may be evaluated for Community Point earning.
10. A business may later participate in Community Point redemption while retaining its own primary loyalty program.

If implementation conflicts with these rules or repository reality:

**STOP AND REPORT. DO NOT REDESIGN THE ARCHITECTURE FOR CONVENIENCE.**

---

## 2. Split 05 purpose

Split 05 creates the authoritative platform domain for:

- explicit Echo Grid Community membership;
- Community Point accounts;
- versioned platform earning rules;
- evidence-based award decisions;
- an append-only Community Point transaction ledger;
- a denormalized customer balance projection;
- customer Community Point balance/history;
- reversal/correction semantics;
- abuse/idempotency controls;
- stable contracts for later redemption fulfillment.

Split 05 does **not** convert Community Points into money, business loyalty, Partner Credits, subscription credits, or orphan claims.

---

## 3. Core ownership model

Canonical model:

```text
GLOBAL CUSTOMER
      ↓
ECHO GRID COMMUNITY MEMBERSHIP
      ↓
COMMUNITY POINT ACCOUNT
      ↓
PLATFORM POLICY EVALUATION
      ↓
APPEND-ONLY COMMUNITY POINT LEDGER
      ↓
DENORMALIZED BALANCE PROJECTION
```

Ownership is platform-wide.

Prohibited model:

```text
Customer
  ↓
Community Point account per business
```

There must be at most one Community Point account per global customer.

Business and branch identifiers may appear only as attribution/context on qualifying evidence or future redemption activity. They never own the Community Point balance.

---

## 4. Community membership source of truth

Split 05 introduces a platform-level Community membership authority.

Expected table:

`community_memberships`

Minimum fields:

- `id`
- `customer_id` — unique
- `status`
- `policy_version`
- `joined_at`
- `left_at` nullable
- `suspended_at` nullable
- `created_at`
- `updated_at`

Initial statuses:

- `active`
- `left`
- `suspended`

Rules:

1. Membership is customer-controlled/platform-controlled, never business-controlled.
2. A business scan, purchase, survey invitation, loyalty enrollment, or staff action must never silently create Community membership.
3. Joining requires an explicit customer action against a disclosed policy version.
4. Leaving Community does not delete point history.
5. Suspension preserves history but prevents earning/redemption until restored.
6. A customer may participate in a survey without becoming a Community member.
7. A customer may become a `community_candidate` without being an active member.

Definitions for Split 04 survey audiences:

- `community_member` = customer has active `community_memberships`.
- `community_candidate` = authenticated customer who is not currently an active Community member and whom the server-side campaign policy allows to participate.

Community candidate status is not itself a stored economic entitlement and does not create a point balance.

---

## 5. Community Point account

Expected table:

`community_point_accounts`

Minimum fields:

- `id`
- `customer_id` — unique
- `status`
- `points_balance`
- `created_at`
- `updated_at`

Initial statuses:

- `active`
- `suspended`
- `closed`

Rules:

- the account is platform-owned;
- one account per global customer;
- `points_balance` is a projection, not ledger truth;
- no business_id or branch_id owns the account;
- closing/suspending an account does not delete ledger history.

An account may be created when Community membership becomes active or immediately before the first valid award, but an award must never silently create Community membership.

---

## 6. Append-only Community Point ledger

Expected table:

`community_point_transactions`

The ledger is the authoritative balance history.

Minimum fields:

- `id`
- `account_id`
- `customer_id`
- `type`
- `points` — signed integer, never zero
- `source_type`
- `source_ref` nullable
- `rule_id` nullable
- `award_decision_id` nullable
- `business_id` nullable attribution only
- `branch_id` nullable attribution only
- `reversal_of` nullable
- `idempotency_key`
- `metadata` narrowly scoped, non-authoritative
- `created_at`
- `created_by` nullable

Initial transaction concepts:

- `earn`
- `redeem` — persistence concept reserved for approved later redemption flows
- `reverse`
- `expire`
- `admin_adjustment`

Sign rules:

- `earn` > 0
- `redeem` < 0
- `reverse` < 0 when reversing a prior earning
- `expire` < 0
- `admin_adjustment` != 0

The substantive ledger fields are immutable after insertion.

Corrections use compensating transactions.

The ledger must never reuse `loyalty_transactions`.

---

## 7. Negative-balance correction rule

If a previously awarded activity is invalidated after the customer has already spent the awarded Community Points, the reversal must still be recorded.

The system must not rewrite history or cap a legitimate reversal merely to keep the balance non-negative.

Therefore:

```text
earn +100
redeem -100
later evidence invalidated
reverse -100
balance = -100
```

A negative balance represents corrective debt in reward units, not money.

While the projected balance is negative:

- further redemption is prohibited;
- future valid earnings offset the negative balance;
- no cash debt is created;
- no external collection obligation is created.

---

## 8. Platform earning rules

Community Point amounts must come from platform-controlled policy, not from survey evidence, QR payloads, businesses, or clients.

Expected table:

`community_point_rules`

Minimum fields:

- `id`
- `source_type`
- `resource_type` nullable
- `resource_id` nullable
- `version`
- `status`
- `points`
- `starts_at` nullable
- `ends_at` nullable
- optional customer/campaign caps where explicitly required
- `created_at`
- `created_by`
- `activated_at` nullable
- `retired_at` nullable

Initial source type implemented in Split 05:

- `survey_completion`

Future approved source types may include:

- approved feedback participation;
- research participation;
- community campaigns.

Those future sources must remain fail-closed until they have their own authoritative evidence contracts.

Rule lifecycle:

- `draft`
- `active`
- `paused`
- `retired`

Activated rule versions are immutable.

A material change creates a new version.

Longer or higher-value surveys may award more points only through an explicit platform rule tied to the relevant survey campaign/resource. The survey record itself remains non-economic.

---

## 9. Evidence-based award decision boundary

Rules Engine / decision authority must remain separate from the ledger.

Expected table:

`community_point_award_decisions`

Minimum fields:

- `id`
- `customer_id`
- `account_id` nullable until award
- `source_type`
- `source_ref`
- `rule_id`
- `status`
- `points`
- `reason_code` nullable
- `evaluated_at`
- `awarded_transaction_id` nullable
- `created_at`

Initial statuses:

- `pending_membership`
- `awarded`
- `rejected`
- `reversed`

Required uniqueness:

```text
(source_type, source_ref, rule_id)
```

This makes policy evaluation retry-safe and prevents duplicate earning from the same evidence/rule.

The award decision is the policy result.

The ledger transaction remains the authoritative economic/reward history.

---

## 10. Split 04 survey completion consumption

The first authoritative earning source is:

`SurveyCompletionEvidence v1`

Stable key:

`completionRef = survey_participations.id`

Canonical flow:

```text
completed survey participation
        ↓
SurveyCompletionEvidence v1
        ↓
Split 05 re-resolves durable evidence
        ↓
active Community Point rule
        ↓
Community membership check
        ↓
award decision
        ↓
append-only earn transaction
        ↓
atomic balance projection update
```

The derived event:

`survey.participation.completed`

may trigger evaluation, but it is not authoritative.

The evaluator must re-resolve the durable completion evidence using `completionRef`.

No raw survey answers are required to award points unless a future locked policy explicitly adds answer-quality qualification. Split 05 must not infer such a rule.

---

## 11. Membership timing and completed evidence

A completed survey does not silently enroll a customer into Community.

If valid evidence is evaluated while the customer is not an active Community member:

- create or retain a retry-safe award decision with `pending_membership`;
- do not write an `earn` ledger entry;
- do not create Community membership;
- do not silently consent on the customer's behalf.

If the customer later explicitly joins Community while the rule/evidence remains eligible, the pending decision may be re-evaluated.

This preserves both:

- non-buyer survey participation;
- explicit Community opt-in.

---

## 12. Invalidated evidence and reversal

If source evidence that produced an award later becomes invalid:

```text
original earn remains
        ↓
new reverse transaction references original earn
        ↓
award decision → reversed
```

Never delete or mutate the original earn transaction.

A reversal must be idempotent and unique against the earning transaction it reverses.

---

## 13. Balance mutation transaction boundary

Every Community Point mutation must be one database transaction containing:

1. lock Community Point account;
2. validate idempotency/policy state;
3. insert append-only transaction;
4. update projected `points_balance`;
5. commit;
6. only then enqueue non-authoritative side effects.

Queue delivery, notifications, analytics, or n8n must never be the source of truth for balance mutation.

---

## 14. Redemption boundary

The locked product architecture allows businesses to participate in Community Point redemption.

However Split 05 must not invent the later partner/economic model.

Split 05 therefore freezes these rules:

1. Community Point spend must eventually be recorded only through the Community Point ledger.
2. A redemption can never mutate a business loyalty balance.
3. A redemption can never directly create Partner Credits or subscription money.
4. Business participation/fulfillment authority must be explicit and server-validated.
5. Partner compensation, Partner Credits, business benefits, and subscription effects remain later-domain responsibilities.
6. No active cross-business redemption flow should be enabled until the Partner Layer contract required by the later split is available.

The `redeem` transaction type may exist in the ledger schema for forward compatibility, but no customer/business route may create it merely because the enum exists.

---

## 15. Customer-facing value

Community Points are non-cash reward units.

Prohibited:

- cash withdrawal;
- cash redemption;
- customer-to-customer transfer;
- external transfer;
- business-to-business transfer;
- automatic conversion into business loyalty;
- automatic conversion into orphan claims;
- automatic conversion into Partner Credits;
- automatic conversion into subscription money;
- presentation as a bank balance or deposit.

Customer UI should use “Community Points”, not currency terminology.

---

## 16. Authorization

Customer authority:

- join Community for self;
- leave Community for self;
- view own Community status;
- view own Community Point balance/history.

Business authority:

- no ability to mint, adjust, or reverse Community Points;
- no access to another customer's global Community history merely because the customer belongs to that business;
- later redemption fulfillment requires a separately locked permission and server-side business/branch context.

Platform authority:

- create/version/activate/retire earning rules;
- perform exceptional audited admin adjustment/reversal;
- suspend Community membership/account under platform policy.

Recommended platform permissions:

- `community:rules:view`
- `community:rules:manage`
- `community:ledger:view`
- `community:adjust`

These are platform-level authorities, not ordinary business-role defaults.

---

## 17. Suggested customer API surfaces

Community membership:

- `GET /api/v1/community/me`
- `POST /api/v1/community/me/join`
- `POST /api/v1/community/me/leave`

Community Points:

- `GET /api/v1/community-points/me`
- `GET /api/v1/community-points/me/transactions`

No business redemption endpoint becomes active in Split 05 unless the later partner-fulfillment contract is first frozen.

---

## 18. Suggested platform API surfaces

- `GET /api/v1/platform/community-point-rules`
- `POST /api/v1/platform/community-point-rules`
- `POST /api/v1/platform/community-point-rules/:id/activate`
- `POST /api/v1/platform/community-point-rules/:id/pause`
- `POST /api/v1/platform/community-point-rules/:id/retire`
- `POST /api/v1/platform/community-points/:customerId/adjust`

Admin adjustment requires:

- explicit reason;
- idempotency key;
- authenticated platform actor;
- audit record.

---

## 19. QR boundary

No Community Point balance, award amount, earning eligibility, membership authority, redemption value, or rule configuration may be embedded in a QR token.

QR remains a context/identity locator.

Server-side resolution determines available Community actions.

Split 05 may later add customer-visible Community actions to the existing resolver only after membership and point APIs exist.

---

## 20. Fraud / abuse controls

At minimum:

- source-evidence uniqueness;
- rule/evidence award uniqueness;
- idempotency keys;
- account row locking;
- immutable ledger;
- reversal uniqueness;
- customer identity verification;
- active-membership checks;
- active-rule checks;
- evidence re-resolution;
- platform audit logging for adjustments.

Existing fraud-signal infrastructure may be reused for suspicious behavior but must not become Community Point ledger truth.

---

## 21. Suggested schema

Additive Split 05 schema:

1. `community_memberships`
2. `community_point_accounts`
3. `community_point_rules`
4. `community_point_award_decisions`
5. `community_point_transactions`

Expected migration:

`0038_split05_community_points.sql`

No existing business loyalty table is replaced or repurposed.

---

## 22. Required tests

### Community membership

- customer must explicitly join;
- business/staff cannot join customer silently;
- leaving preserves history;
- suspended/left member cannot earn new points;
- `community_member` survey audience resolves only for active membership;
- `community_candidate` does not imply active membership.

### Earning

- completed survey evidence can be evaluated;
- incomplete/nonexistent evidence rejected;
- derived event alone cannot award;
- inactive/paused rule cannot award;
- same completion + same rule cannot double-award;
- rule amount, not evidence/client payload, determines points;
- non-member evidence becomes `pending_membership`;
- explicit later join may re-evaluate pending evidence.

### Ledger

- earn is append-only;
- projection equals ledger sum;
- mutations are transactional;
- identical idempotent replay returns existing result;
- conflicting idempotency replay fails;
- business loyalty balance unchanged.

### Reversal

- invalidated awarded evidence creates compensating reverse;
- original earn remains;
- repeated reversal does not duplicate;
- reversal may drive Community balance negative;
- negative balance blocks redemption.

### Isolation

- Community account is global/customer-owned, not business-owned;
- business staff cannot mint points;
- business staff cannot read global Community history without future explicit redemption authority;
- no Community transaction writes `loyalty_transactions`.

### Architecture

- no orphan-settlement entry;
- no Partner Credit entry;
- no Stripe/subscription mutation;
- no cash-value representation;
- no points in QR payloads.

---

## 23. Definition of Done

Split 05 is LOCKED COMPLETE only when:

- Community membership is an explicit platform-level source of truth;
- one Community Point account exists per customer;
- append-only Community Point ledger is authoritative;
- balance is a projection;
- platform earning rules are versioned;
- Split 04 evidence is consumed by stable `completionRef`;
- award decisions are idempotent;
- non-member evidence does not silently enroll or award;
- reversal/correction uses compensating transactions;
- negative corrective balances are safe and non-cash;
- customer balance/history APIs are isolated;
- business loyalty remains untouched;
- business redemption remains disabled until its later partner contract;
- no orphan settlement, Partner Credit, or billing economics are introduced;
- migration drift passes;
- PostgreSQL replay passes;
- permission seed passes;
- API/web typecheck passes;
- unit/integration tests pass;
- API/web builds pass;
- browser verification passes;
- completion report is merged to `main`.

---

## 24. Frozen conflict rule

If implementation requires changing:

- Community Point ownership;
- Community membership consent;
- business loyalty ownership;
- the Split 04 completion-evidence contract;
- ledger append-only semantics;
- non-cash treatment;
- Partner Credit separation;
- orphan-settlement separation;
- subscription separation;

**STOP AND REPORT THE ARCHITECTURAL CONFLICT BEFORE CODING.**

---

## 25. Lock declaration

**ECHO GRID SPLIT 05 — COMMUNITY POINTS v1.0 IS FROZEN FOR IMPLEMENTATION.**

Implementation may refine internal technical details only where every ownership rule, ledger rule, evidence boundary, opt-in rule, and financial-domain separation above remains intact.
