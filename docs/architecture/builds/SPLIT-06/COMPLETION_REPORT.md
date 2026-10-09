# ECHO GRID — SPLIT 06 COMPLETION REPORT

**Split:** 06 — Orphan Reward Claims & Settlement  
**Version:** v1.0  
**Status:** LOCKED COMPLETE ON MERGE  
**Architecture spec:** `ECHO_GRID_SPLIT_06_ORPHAN_SETTLEMENT_v1.0.md`  
**Implementation audit:** `IMPLEMENTATION_LOCK_AUDIT.md`

---

## 1. Completion declaration

Split 06 implements the platform-owned cross-business orphan reward claim and settlement domain without merging it into business loyalty, Community Points, Partner Credits, or billing.

Canonical implemented lifecycle:

```text
ORIGIN BUSINESS LOYALTY
        ↓
OUTSTANDING ISSUED NON-POINTS REWARD
        ↓
ORPHAN QUALIFICATION
        ↓
ORPHAN REWARD CLAIM
        ↓
CUSTOMER ACCESS AUTHORIZATION
        ↓
RECEIVING BUSINESS ACCEPTANCE
        ↓
SETTLEMENT RESERVATION
        ↓
CUSTOMER COMPLETION AUTHORIZATION
        ↓
RECEIVING BUSINESS FULFILLMENT
        ↓
APPEND-ONLY SETTLEMENT HISTORY
        ↓
ORPHAN SETTLEMENT COMPLETION EVIDENCE v1
```

Non-happy-path support includes:

- reservation expiry;
- customer cancellation;
- safe claim release;
- fulfilled-settlement platform reversal;
- completion-evidence invalidation;
- reversal evidence.

---

## 2. Durable Split 06 schema

Migration:

`0039_split06_orphan_settlement.sql`

Tables:

1. `orphan_reward_claims`
2. `orphan_settlements`
3. `orphan_settlement_events`

Core database invariants include:

- unique source loyalty transaction per orphan claim;
- non-points initial source reward types;
- frozen claim/settlement/event status vocabularies;
- at most one active accepted/reserved/completion-authorized reservation per claim;
- required acceptance/completion/fulfillment projection evidence;
- unique append-event idempotency keys.

---

## 3. Implemented authority surfaces

Customer:

- own orphan claim list/read;
- authorize settlement access;
- review settlement fulfillment contract;
- authorize settlement completion;
- cancel pre-fulfillment settlement.

Receiving business/staff:

- minimum authorized settlement access;
- explicit accept/reserve;
- fulfill after customer completion authorization;
- own settlement history with trusted branch scoping.

Platform:

- authoritative qualification for approved platform-unable-to-honor condition;
- admin-only fulfilled settlement reversal with explicit evidence and semantic audit.

QR:

- staff Customer-QR resolver can expose `REQUEST_ORPHAN_SETTLEMENT_ACCESS` without checking whether the customer owns orphan value;
- customer Business-QR resolver can expose `SETTLE_ORPHAN_REWARD` only under server-side eligibility.

---

## 4. Permission and authorization model

Business permissions:

- `settlement:view`
- `settlement:accept`
- `settlement:fulfill`

Default roles:

- Owner — yes
- Admin — yes
- Manager — yes within trusted scope
- Staff — no

Customer authority reuses Split 01:

- consent purpose `settlement_access`;
- action `access_orphan_settlement`;
- action `complete_settlement`.

No duplicate consent system exists.

---

## 5. Evidence contracts

### OrphanSettlementCompletionEvidence v1

Stable key:

`settlementRef = orphan_settlements.id`

Value-neutral handoff for Split 07.

### OrphanSettlementReversalEvidence v1

Identifies authoritative invalidation of a previously fulfilled settlement.

Neither contract calculates downstream compensation.

---

## 6. Isolation guarantees

Split 06 does not:

- transfer raw business loyalty points;
- write settlement value into receiving loyalty;
- mutate origin loyalty history;
- debit/credit Community Points;
- create Partner Credits;
- apply subscription credits;
- modify Stripe;
- calculate cash value.

---

## 7. Explicitly deferred

### Split 07

- Partner Credit accounts/ledger;
- settlement-to-credit compensation policy;
- Partner Panel;
- downstream reversal propagation for Partner Credits.

### Split 08

- subscription credit application;
- invoice offsets;
- Stripe changes;
- accounting reconciliation;
- billing reversal propagation.

### Future explicit orphan-claim expiry policy

The schema supports claim `expired`, but Split 06 v1 does not invent automatic claim-expiry rules because the frozen architecture requires an explicit platform policy that does not yet exist.

---

## 8. Implementation chain

| PR | Block | Merge commit |
| ---: | --- | --- |
| #68 | architecture freeze | `07ee8e1b6afc827328ca468a165148d5d2531b65` |
| #69 | Block 1 | `8f539cef1d17afd37e5163fdbab83f0e9450178e` |
| #70 | Block 2 | `bf1f55831f15fac9bb58b2aaafabb892a19c8770` |
| #71 | Block 3 | `f5106869f8a62d9e6d3cc18a9cda48a75bb7b9ab` |
| #72 | Block 4 | `b4aa60d1cb6cc5ad591fa587bb582d75b89fc27b` |
| #73 | Block 5 | `4d271d45ceda6ca2748f8d7baf77f8d148a25b34` |
| #74 | Block 6 | `24f9e24bee8950870ccb23e498d8c968ebde6cbf` |
| #75 | Block 7 | `ec902092a999a57c86398010405b792e3b85c899` |
| #76 | Block 8 | `9df9e2c87b862ce5dffb7660690877a56307ede3` |

The completion-hardening/lock PR follows this chain and closes QR/history gaps before final lock.

---

## 9. Lock conditions

This report may be treated as authoritative only after the completion-hardening PR passes:

- migration drift;
- lint;
- static security/readiness checks;
- API typecheck;
- web typecheck;
- API unit tests;
- web unit tests;
- fresh PostgreSQL migration replay;
- permission seed;
- real-Postgres integration;
- API production build;
- web production build;
- browser verification;

and this report is merged to authoritative `main`.

After those conditions are met:

**ECHO GRID SPLIT 06 — ORPHAN REWARD CLAIMS & SETTLEMENT v1.0 IS LOCKED COMPLETE.**

Changes to its ownership model, source authority, consent model, two-party acceptance, event history, ledger isolation, QR boundary, completion-evidence contract, or downstream-domain separation require an explicit architecture amendment.
