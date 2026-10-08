# ECHO GRID — SPLIT 05 COMPLETION REPORT

## Status

**Gate state:** LOCKED COMPLETE

**Split:** 05 — Community Points  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Frozen specification:** `ECHO_GRID_SPLIT_05_COMMUNITY_POINTS_v1.0.md`  
**Authoritative implementation merge:** PR #66  
**Implementation merge commit:** `3299d9904e752ba3a75e00d8b2862e45fc69a301`  
**Completion-proof CI:** CI/CD run #420 on head `e7506e2d73cc6a9d3aea6750611b7d9a433a5b28`

This report closes the implementation scope defined by the frozen Split 05 specification.
It also reconciles Community Points against the locked Echo Grid loyalty architecture and Splits 01–04.

---

## 1. Ownership and domain boundary

Split 05 implements one platform-owned Community Point domain per global customer.

Canonical ownership remains:

```text
GLOBAL CUSTOMER
      ↓
ECHO GRID COMMUNITY MEMBERSHIP
      ↓
COMMUNITY POINT ACCOUNT
      ↓
PLATFORM POLICY / EVIDENCE EVALUATION
      ↓
APPEND-ONLY COMMUNITY POINT LEDGER
      ↓
DENORMALIZED BALANCE PROJECTION
```

The implementation does not create a Community Point account per business or branch.

Business and branch IDs may appear only as attribution on qualifying evidence/ledger rows. They do not own the balance.

Community Points remain distinct from:

- business loyalty;
- orphan reward claims;
- Partner Credits;
- subscription billing;
- Stripe/payment state;
- cash or bank-value representations.

---

## 2. Explicit Community membership

Authoritative membership storage:

`community_memberships`

Supported lifecycle:

- `active`
- `left`
- `suspended`

Implemented rules:

- customer joins explicitly with a disclosed policy version;
- survey completion, QR scan, business action, or staff action does not silently join a customer;
- customer leave preserves membership/account/ledger history;
- customer self-service cannot override a platform suspension;
- suspended membership does not qualify as active membership;
- rejoining after ordinary `left` reuses the same membership/account identity;
- platform suspension/restoration changes membership and point-account state atomically.

A Community Point account is created through explicit Community activation, not through survey participation alone.

---

## 3. Community survey audience semantics

Split 05 completes the Split 04 audience bridge.

`community_member` means:

```text
active community_memberships row
```

`community_candidate` means:

```text
authenticated customer
AND no active Community membership
AND current campaign policy admits the audience
```

Candidate eligibility:

- is not a stored entitlement;
- does not create Community membership;
- does not create a Community Point account;
- does not create point balance.

QR survey discovery and direct survey participation use the same server-side Community membership authority.

---

## 4. Community Point account and ledger

Authoritative balance history:

`community_point_transactions`

Projected account:

`community_point_accounts.points_balance`

The account is global/customer-owned and unique by customer.

Ledger properties:

- append-only;
- no update/delete repository methods;
- signed non-zero point deltas;
- deterministic/idempotent mutation keys;
- business/branch fields attribution-only;
- immutable original economic/reward history;
- projected balance updated atomically with ledger mutation.

The implementation never reuses `loyalty_transactions`.

Real-Postgres tests prove the projected balance equals the sum of Community ledger deltas in the tested mutation flows.

---

## 5. Earning rules and evidence authority

Platform earning rules are stored in:

`community_point_rules`

Implemented rule behavior:

- versioned;
- draft/active/paused/retired lifecycle;
- immutable earning content after creation;
- serialized version allocation;
- one active rule per source/resource scope;
- global fallback plus campaign-specific rule resolution;
- inactive/paused rules cannot award;
- survey-campaign rule resources are server-validated;
- rule lifecycle mutations are semantically audited in the same database transaction.

The first authoritative earning source remains:

`SurveyCompletionEvidence v1`

Stable evidence key:

`completionRef = survey_participations.id`

The award evaluator re-resolves durable Postgres evidence by `completionRef`.

A derived `survey.participation.completed` event is not ledger authority and no Community award path trusts an event payload as final evidence.

---

## 6. Award decisions and membership timing

Policy decisions are stored separately from the ledger in:

`community_point_award_decisions`

Uniqueness:

```text
(source_type, source_ref, rule_id)
```

Behavior:

- completed evidence can be evaluated;
- incomplete/nonexistent evidence is rejected;
- same completion + same rule cannot double-award;
- point amount comes from the active platform rule;
- non-member/suspended-member evidence produces or retains `pending_membership`;
- no membership or point account is silently created from evidence;
- later explicit activation/restoration may re-evaluate pending evidence;
- award decisions and ledger state remain separate authorities.

---

## 7. Evidence-owned reversal

Invalidated awarded survey evidence uses the dedicated reversal path.

Canonical correction:

```text
original earn remains
        ↓
new reverse transaction
        ↓
reversal_of = original earn
        ↓
award decision = reversed
```

Rules proven by integration tests:

- source evidence must actually be invalidated;
- original earn remains immutable;
- only one reversal is created;
- repeated reversal is idempotent;
- reversal can drive the Community balance negative.

A negative balance is corrective reward-unit debt only. It is not money and creates no external collection obligation.

Community redemption is not active in Split 05, so a negative Community balance cannot be spent through any Community redemption API.

---

## 8. Customer balance/history authority

Customer routes:

- `GET /api/v1/community-points/me`
- `GET /api/v1/community-points/me/transactions`

Authority derives exclusively from the authenticated customer token.

There is no caller-supplied customer identity on the self-service read surface.

Real-Postgres coverage proves:

- customer A cannot read customer B's Community account/history through the service boundary;
- closed accounts and historical ledger remain readable after leave;
- reading does not create Community membership or an account.

---

## 9. Platform ledger inspection

Platform route:

`GET /api/v1/platform/community-point-ledger`

Permission:

`community:ledger:view`

Supported platform roles under the frozen permission matrix:

- support;
- billing;
- admin.

The route is platform-authorized, not business-tenant RBAC authorized.

It supports bounded filtering/pagination over the global Community ledger without granting ordinary business staff global Community history access.

---

## 10. Platform rule administration

Platform rule routes:

- `GET /api/v1/platform/community-point-rules`
- `POST /api/v1/platform/community-point-rules`
- `POST /api/v1/platform/community-point-rules/:id/activate`
- `POST /api/v1/platform/community-point-rules/:id/pause`
- `POST /api/v1/platform/community-point-rules/:id/retire`

Permissions:

- read: `community:rules:view`
- mutation: `community:rules:manage`

Rule mutations write semantic audit rows transactionally.

Audit failure rolls back the associated rule mutation.

---

## 11. Exceptional platform adjustment/correction

Platform mutation authority:

`community:adjust`

This permission is admin-only under the frozen platform permission matrix.

Routes:

- `POST /api/v1/platform/community-points/:customerId/adjust`
- `POST /api/v1/platform/community-points/transactions/:transactionId/reverse`

Manual adjustment rules:

- signed non-zero `admin_adjustment`;
- explicit reason;
- explicit idempotency key;
- existing Community account required;
- account row lock;
- append-only ledger insertion;
- atomic balance projection update;
- semantic audit in the same transaction;
- conflicting idempotency replay fails.

Manual correction is limited to platform-created `admin_adjustment` entries.

Survey-earned transactions cannot be manually reversed through this endpoint. Evidence-owned earnings continue through the authoritative invalidation/reversal service.

A correction of a negative admin adjustment is represented by an opposite-signed `admin_adjustment`, preserving the schema's negative-only meaning for the dedicated `reverse` transaction type.

---

## 12. Platform suspension/restoration

Routes:

- `POST /api/v1/platform/community-points/:customerId/suspend`
- `POST /api/v1/platform/community-points/:customerId/restore`

Authority:

`community:adjust`

Paired lifecycle invariant:

```text
membership active   + account active
          ↕
membership suspended + account suspended
```

Behavior:

- balance preserved;
- ledger/history preserved;
- no delete/recreate/reset;
- no point mutation from suspension itself;
- earning blocked while suspended;
- pending valid evidence may award after restoration;
- mismatched membership/account states fail with `COMMUNITY_STATE_CONFLICT`;
- no silent state repair;
- semantic audit and both state changes commit atomically;
- audit failure rolls back both state changes;
- repeat suspend/restore requests are no-op replays and do not create duplicate semantic audit rows.

---

## 13. Authorization and isolation

Customer authority:

- join/leave Community for self;
- view own Community state;
- view own Community Point balance/history.

Business/branch authority:

- cannot mint Community Points;
- cannot adjust/reverse Community Points;
- cannot suspend/restore Community state;
- cannot read a customer's global Community ledger merely through business membership.

Platform authority:

- explicit Community permissions only;
- fresh platform-role authorization;
- business RBAC is not used as a substitute for platform authority.

Permission set:

- `community:rules:view`
- `community:rules:manage`
- `community:ledger:view`
- `community:adjust`

---

## 14. Business loyalty isolation

Split 05 does not mutate business loyalty economics.

Real-Postgres completion hardening creates a real business loyalty account for the same customer, awards Community Points, and proves:

- business loyalty account points remain unchanged;
- `loyalty_transactions` receives no Community transaction;
- Community balance changes only in `community_point_accounts`;
- Community ledger writes only `community_point_transactions`.

This is a direct executable proof of the locked rule:

`BUSINESS LOYALTY != COMMUNITY POINTS`

---

## 15. Redemption and later-domain boundary

Split 05 deliberately exposes no active Community Point redemption endpoint.

The `redeem` transaction enum/source exists only as forward-compatible persistence vocabulary.

No Split 05 route creates Community redemption.

No implementation was introduced for:

- partner fulfillment;
- Partner Credits;
- orphan reward settlement;
- subscription compensation;
- Stripe billing mutation;
- cross-business economic settlement.

Those remain later-domain responsibilities.

---

## 16. QR boundary

QR remains a context/identity locator.

No QR payload contains authoritative:

- Community Point balance;
- Community Point award amount;
- Community earning eligibility;
- Community rule configuration;
- redemption value;
- membership authority.

Survey availability is resolved server-side from current membership/campaign state.

---

## 17. Required-test reconciliation

### Community membership

| Frozen requirement | Evidence | State |
| --- | --- | --- |
| Customer explicitly joins | `community-membership.integration.test.ts` | PASS |
| Business/staff cannot silently join | membership route/service authority + no business creation path | PASS |
| Leaving preserves history | customer read integration coverage | PASS |
| Suspended/left cannot earn | award + platform-state integration coverage | PASS |
| `community_member` only active membership | Community survey audience integration | PASS |
| `community_candidate` does not imply membership | Community survey audience integration | PASS |

### Earning

| Frozen requirement | State |
| --- | --- |
| Completed evidence evaluates | PASS |
| Incomplete/nonexistent evidence rejected | PASS |
| Derived event alone cannot award | PASS — evaluator re-resolves durable evidence; no event-authority award path |
| Inactive/paused rule cannot award | PASS |
| Same completion + rule no double-award | PASS |
| Rule controls amount | PASS |
| Non-member -> `pending_membership` | PASS |
| Later explicit join/restore may re-evaluate | PASS |

### Ledger

| Frozen requirement | State |
| --- | --- |
| Append-only earn/history | PASS |
| Projection equals ledger sum | PASS |
| Mutations transactional | PASS |
| Identical idempotent replay returns existing result | PASS |
| Conflicting idempotency replay fails | PASS |
| Business loyalty balance unchanged | PASS |

### Reversal

| Frozen requirement | State |
| --- | --- |
| Invalidated award creates compensating reverse | PASS |
| Original earn remains | PASS |
| Repeated reversal no duplicate | PASS |
| Reversal may drive balance negative | PASS |
| Negative balance blocks redemption | PASS under stronger Split 05 boundary: no Community redemption API exists |

### Isolation

| Frozen requirement | State |
| --- | --- |
| Global/customer-owned Community account | PASS |
| Business staff cannot mint | PASS |
| Business staff cannot read global history | PASS |
| No Community write to `loyalty_transactions` | PASS |

### Architecture

| Frozen requirement | State |
| --- | --- |
| No orphan settlement entry | PASS |
| No Partner Credit entry | PASS |
| No Stripe/subscription mutation | PASS |
| No cash-value representation | PASS |
| No points/economic truth in QR | PASS |

---

## 18. Repository gate evidence

The completion-proof candidate was validated by **CI/CD run #420** on head:

`e7506e2d73cc6a9d3aea6750611b7d9a433a5b28`

All merge-gating verification steps passed:

- migration drift / `db:check`;
- lint;
- Block 2E static security verification;
- Block 2F environment/release verification;
- Block 2G commercial/billing verification;
- Block 2H final static readiness;
- API typecheck;
- web typecheck;
- API unit tests;
- web unit tests;
- complete migration replay against fresh PostgreSQL 16;
- permission catalog seed;
- API integration tests against real PostgreSQL;
- API build / Wrangler dry run;
- web production build;
- Chromium installation;
- Block 2D browser verification.

The candidate was then merged to `main` through PR #66 as:

`3299d9904e752ba3a75e00d8b2862e45fc69a301`

---

## 19. Definition-of-Done disposition

| Requirement | State |
| --- | --- |
| Explicit platform Community membership source of truth | PASS |
| One Community Point account per customer | PASS |
| Append-only Community ledger authoritative | PASS |
| Balance is a projection | PASS |
| Versioned platform earning rules | PASS |
| Stable Split 04 `completionRef` evidence consumed | PASS |
| Idempotent award decisions | PASS |
| Non-member evidence does not silently enroll/award | PASS |
| Compensating reversal/correction semantics | PASS |
| Negative corrective balances remain non-cash | PASS |
| Customer balance/history isolated | PASS |
| Platform ledger inspection explicitly permissioned | PASS |
| Exceptional admin adjustments audited/transactional | PASS |
| Platform suspension/restoration audited/transactional | PASS |
| Community survey audiences reconciled | PASS |
| Business loyalty untouched | PASS |
| Community redemption disabled pending later partner contract | PASS |
| No orphan settlement / Partner Credit / billing economics | PASS |
| Migration drift | PASS — CI #420 |
| Fresh PostgreSQL migration replay | PASS — CI #420 |
| Permission seed | PASS — CI #420 |
| API/web typecheck | PASS — CI #420 |
| Unit/integration tests | PASS — CI #420 |
| API/web builds | PASS — CI #420 |
| Browser verification | PASS — CI #420 |
| Completion-proof implementation merged to main | PASS — PR #66 / `3299d990` |
| Completion report exists | PASS |

---

## 20. Superseded implementation PRs

PR #66 intentionally consolidated the final open Split 05 implementation stack into one completion-proof candidate.

Therefore:

- PR #64 — audited Community Point admin adjustments;
- PR #65 — platform Community suspension/restoration;

are superseded by PR #66 and must not be merged separately after #66.

Their implementation is already contained in the authoritative PR #66 merge.

---

## 21. Final lock rule

**ECHO GRID SPLIT 05 — COMMUNITY POINTS v1.0 IS LOCKED COMPLETE.**

The completion-proof implementation passed the full repository verification gate and is merged to authoritative `main`.

Any future work involving:

- Community redemption;
- partner fulfillment;
- Partner Credits;
- orphan reward settlement;
- cross-business settlement;
- subscription/billing compensation;
- new Community earning evidence sources;
- new QR economic actions;

must proceed under the appropriate later split or an explicit architecture amendment.

Split 05 ownership, membership consent, ledger authority, evidence authority, correction semantics, and financial-domain separation are frozen.
