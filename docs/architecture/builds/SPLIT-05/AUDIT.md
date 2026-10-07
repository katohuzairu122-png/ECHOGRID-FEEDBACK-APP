# ECHO GRID — SPLIT 05 REPOSITORY AUDIT

**Split:** 05 — Community Points  
**Audit status:** COMPLETE  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Audited branch:** `main` after Split 04 merge  
**Implementation branch:** `architecture/split-05-community-points`

---

## 1. Executive finding

The current authoritative repository contains **no Community Points implementation**.

There is no:

- Community membership source of truth;
- Community Point account;
- Community Point ledger;
- Community Point rule/policy table;
- Community Point award-decision table;
- Community Point earning service;
- Community Point redemption service;
- customer Community Point balance/history API;
- platform Community Point rule-management API.

This is the correct starting point for Split 05.

The repository does contain the exact upstream primitives Split 05 should reuse:

- one global customer identity;
- Split 04 survey completion evidence;
- append-only ledger conventions;
- audit logging;
- idempotency patterns;
- customer authentication;
- platform-role middleware;
- fraud-signal infrastructure;
- Postgres transaction and repository patterns;
- QR server-resolution boundaries.

---

## 2. Authoritative locked source

The locked loyalty architecture explicitly states:

```text
BUSINESS LOYALTY != COMMUNITY POINTS
```

and requires Community Points to have their own ledger.

Approved future earning categories include:

- verified surveys;
- approved feedback participation;
- research participation;
- community campaigns.

It also locks financial separation among:

- Business Loyalty Points;
- Community Points;
- Orphan Reward Claims;
- Partner Credits;
- Subscription Billing.

Therefore existing `loyalty_accounts` / `loyalty_transactions` are **not reusable as Community Point storage**.

---

## 3. Repository classification

| Area | Current repository | Split 05 classification |
| --- | --- | --- |
| Global customer identity | present | REUSE |
| Customer JWT/auth | present | REUSE |
| Business/branch tenancy | present | REUSE FOR ATTRIBUTION ONLY |
| Business loyalty accounts | present | DO NOT REUSE FOR COMMUNITY BALANCE |
| Business loyalty ledger | present | PATTERN ONLY — DO NOT WRITE COMMUNITY POINTS HERE |
| Split 04 survey completion evidence | present | REUSE AS FIRST EARNING SOURCE |
| `survey.participation.completed` event | present | OPTIONAL TRIGGER ONLY |
| Survey completionRef | present | REUSE AS AUTHORITATIVE SOURCE REF |
| Consent infrastructure | present | REUSE PATTERN; COMMUNITY JOIN REMAINS EXPLICIT |
| Audit log | present | REUSE |
| Fraud signals | present | REUSE FOR ABUSE SIGNALS, NOT LEDGER TRUTH |
| Platform role middleware | present | REUSE |
| Notification infrastructure | present | REUSE LATER FOR SIDE EFFECTS |
| Community membership SOT | missing | ADD |
| Community Point account | missing | ADD |
| Community Point ledger | missing | ADD |
| Earning rules | missing | ADD |
| Award decision/evaluation record | missing | ADD |
| Customer balance/history routes | missing | ADD |
| Platform rules/admin routes | missing | ADD |
| Community redemption fulfillment | missing | CONTRACT ONLY / DEFER PARTNER FLOW |
| Partner Credits | missing | DEFER SPLIT 07 |
| Orphan settlement | missing | DEFER SPLIT 06 |
| Subscription compensation | legacy billing exists | DEFER SPLIT 08 |
| PR #51 community choice work | old open draft | QUARANTINE / SOURCE MATERIAL ONLY |

---

## 4. Split 04 handoff is ready

Split 04 now supplies:

`SurveyCompletionEvidence v1`

with stable:

```text
completionRef = survey_participations.id
```

The evidence contains:

- participant customer;
- survey;
- immutable survey version;
- campaign;
- business/branch attribution;
- participation source;
- completion timestamp.

It intentionally contains no:

- Community Point amount;
- reward eligibility;
- business loyalty value;
- settlement value;
- billing value.

This is the correct Split 05 input boundary.

The evaluator must re-resolve evidence by `completionRef`; the derived event must never be accepted as ledger authority by itself.

---

## 5. Survey audience gap now belongs to Split 05

Split 04 already defines:

- `community_candidate`
- `community_member`

but fails both closed because no Community membership source of truth exists.

Split 05 must close this gap by introducing explicit `community_memberships`.

After implementation:

- `community_member` resolves from active Community membership;
- `community_candidate` remains non-economic and must not imply membership or point entitlement.

No business action may create the membership.

---

## 6. Existing loyalty ledger cannot be extended

`loyalty_transactions` is tied to:

`loyalty_account_id`

and therefore to:

`(customer_id, business_id)`

That ledger is business loyalty history.

Adding Community Point rows to it would violate:

- platform ownership;
- financial-domain separation;
- business/account isolation;
- existing balance projections;
- existing analytics semantics.

Result:

**Community Points require new tables.**

---

## 7. Existing account projection pattern is reusable

Current loyalty architecture already uses:

```text
append-only transactions
        ↓
denormalized current total
```

Split 05 should reuse the pattern, not the tables.

Expected equivalent:

```text
community_point_transactions
        ↓
community_point_accounts.points_balance
```

Ledger sum remains authoritative; account balance is a projection.

---

## 8. Existing idempotency patterns are reusable

Repository patterns already exist for:

- feedback submission;
- loyalty purchase events;
- survey participation start/submit;
- consent creation;
- completion evidence.

Split 05 should use:

- explicit idempotency keys for mutations;
- unique source evidence/rule keys;
- insert-on-conflict/replay resolution;
- 409 conflict for materially different replay.

No award should depend on queue exactly-once delivery.

---

## 9. Existing audit infrastructure is reusable

`audit_log` is append-only and already supports:

- actor;
- entity type/id;
- metadata;
- timestamps.

Platform Community Point operations requiring audit include:

- rule creation;
- rule activation/pause/retirement;
- admin adjustment;
- suspension;
- exceptional reversal.

Do not create a second general-purpose audit system.

---

## 10. Existing fraud infrastructure is reusable but not authoritative

`fraud_signals` can capture:

- suspicious repeated evidence;
- velocity abuse;
- anomalous participation patterns;
- redemption abuse later.

But fraud signals must never become the basis of balance history.

The Community Point ledger remains authoritative.

A fraud signal may block or queue evaluation according to policy; it does not itself add/remove points.

---

## 11. Platform authorization primitives exist

The repository already has:

- `require-platform-role`;
- platform admin seed infrastructure;
- platform operational routes.

Split 05 platform rule/adjustment endpoints should use those existing trust boundaries.

Recommended new platform permissions/authority concepts from the frozen spec:

- `community:rules:view`
- `community:rules:manage`
- `community:ledger:view`
- `community:adjust`

These must not become default ordinary business-role permissions.

---

## 12. Customer authorization primitives exist

Customer JWT authentication is already separate from staff JWT/RBAC.

Split 05 should preserve the route boundary:

```text
/customer-authenticated Community self-service
!=
staff/business Community administration
!=
platform Community policy administration
```

Customer routes must always resolve identity from the JWT, never a caller-supplied customer id.

---

## 13. PR #51 quarantine finding

PR #51 remains:

- open;
- unmerged;
- based on superseded architecture;
- contains obsolete migration `0034_branch_loyalty_community_v1.sql`.

It includes a prior `customer_community_choices` concept, but it is coupled to the rejected branch-owned loyalty model.

Classification:

```text
CONCEPTUAL SOURCE ONLY
DO NOT MERGE
DO NOT REUSE ITS MIGRATION
DO NOT REUSE BRANCH-OWNED BALANCE/MEMBERSHIP MODEL
```

Useful concept retained from that abandoned branch:

- Community participation must be an explicit customer choice.

Implementation must be rebuilt against Splits 01–05.

---

## 14. Migration sequence

Current Drizzle journal ends at:

`0037_sad_shiva`

Therefore the next controlled migration number is:

`0038`

Expected generated migration:

`0038_<drizzle_generated_name>.sql`

Architecture/reporting shorthand:

`0038_split05_community_points.sql`

The actual filename must follow Drizzle generation output and metadata.

---

## 15. Required additive schema

Expected Split 05 tables:

1. `community_memberships`
2. `community_point_accounts`
3. `community_point_rules`
4. `community_point_award_decisions`
5. `community_point_transactions`

No existing loyalty table should be repurposed.

No settlement or Partner Credit table should be added in this split.

---

## 16. First earning source

The first implementation-ready earning source is:

`survey_completion`

using:

`SurveyCompletionEvidence v1`

Other source categories listed by the locked loyalty architecture remain architectural possibilities only until an authoritative evidence contract exists.

Therefore:

| Potential source | Current evidence authority | Split 05 |
| --- | --- | --- |
| Verified survey | YES | IMPLEMENT |
| Approved feedback participation | NO locked reward-evidence contract | FAIL CLOSED |
| Research participation | NO implementation | FAIL CLOSED |
| Community campaign | NO implementation | FAIL CLOSED |

Do not infer Community Point eligibility directly from raw feedback rows.

---

## 17. Community membership semantics

There is currently no authoritative membership table.

Split 05 must add one.

Required behavior:

- explicit customer join;
- policy version recorded;
- leave/suspend without history deletion;
- no silent join on survey completion;
- no silent join by a business;
- no silent join by QR scan;
- no point award before active membership.

Completed evidence before membership should become a retry-safe `pending_membership` decision rather than a point transaction.

---

## 18. Award decision layer is missing

Current repository has no object separating:

```text
policy decision
from
ledger mutation
```

Split 05 needs this because:

- evidence may be valid but customer not yet a member;
- evidence may be valid but rule inactive;
- evaluation may retry;
- an award may later be reversed;
- rule version must be auditable.

Expected:

`community_point_award_decisions`

The ledger must not be used as both evaluator and policy-decision store.

---

## 19. Redemption gap

No Community redemption flow exists.

The locked architecture allows businesses to participate in Community redemption, but current repository has no:

- partner eligibility source;
- partner fulfillment authority;
- Partner Credit source;
- approved Community redemption catalog.

Therefore Split 05 must **not** activate a business redemption flow.

The ledger may reserve a future `redeem` transaction concept, but creation of that transaction must remain unreachable until the later partner contract is frozen and implemented.

---

## 20. Billing/economic boundary

Existing subscription billing code must not be touched by Split 05 earning.

Community Point earning must not:

- reduce invoices;
- create Stripe credits;
- create subscription discounts;
- create Partner Credits.

Any later business compensation for Community participation belongs to a later economic integration split.

---

## 21. QR boundary

Split 04 already proves the correct approach:

- QR identifies context;
- server resolves current actions.

Split 05 may eventually expose Community self-service actions via resolver response, but:

- balance cannot be embedded in QR;
- award amount cannot be embedded in QR;
- membership cannot be inferred from QR possession;
- no redemption authority can be embedded in QR.

---

## 22. Suggested implementation order

1. shared Community / Community Point types and validators;
2. schema for five Split 05 tables;
3. Drizzle migration 0038 + snapshot/journal;
4. relations/index exports;
5. repositories;
6. Community membership service;
7. customer join/leave/status routes;
8. Community Point account/ledger transaction service;
9. platform earning-rule service;
10. survey-completion evaluator;
11. pending-membership re-evaluation;
12. evidence invalidation reversal;
13. customer balance/history routes;
14. platform rule/adjustment routes;
15. survey audience integration;
16. audit/fraud integration;
17. unit tests;
18. real-Postgres integration tests;
19. migration drift/typecheck/build/browser gate;
20. completion report;
21. merge and lock.

---

## 23. Mandatory real-Postgres scenarios

At minimum:

- customer explicitly joins;
- duplicate join is idempotent;
- business cannot enroll customer;
- one account per customer;
- one survey completion/rule produces one award;
- duplicate evaluator run produces no duplicate ledger entry;
- non-member completion becomes pending;
- later explicit join releases eligible pending award exactly once;
- invalidated evidence reverses prior earn;
- original earn remains;
- reversal can create negative balance;
- projected balance equals ledger sum;
- business loyalty account/ledger remains unchanged;
- platform admin adjustment is audited;
- no Community mutation touches Stripe/billing;
- no orphan/Partner Credit row exists.

---

## 24. Audit conclusion

Repository reality is compatible with the frozen Split 05 architecture.

There is no existing Community Points implementation that must be migrated.

The correct path is additive:

```text
Split 04 completion evidence
        ↓
new Split 05 policy/membership/account/ledger domain
```

No architecture conflict requiring an amendment was found.

PR #51 remains quarantined and must not be merged.

**Split 05 architecture is ready for schema implementation beginning with migration 0038.**
