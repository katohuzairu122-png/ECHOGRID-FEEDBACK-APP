# ECHO GRID — SPLIT 06 ARCHITECTURE RECONCILIATION AUDIT

**Status:** PASS — READY TO FREEZE  
**Split:** 06 — Orphan Reward Claims & Settlement  
**Baseline:** authoritative `main` after Split 05 lock  
**Architecture spec:** `ECHO_GRID_SPLIT_06_ORPHAN_SETTLEMENT_v1.0.md`

---

## 1. Repository reality

Split 06 settlement itself is not currently implemented.

Relevant existing foundations are present:

| Repository capability | State | Split 06 disposition |
| --- | --- | --- |
| Global customer identity | present | REUSE |
| Business customer membership | present | REUSE |
| Business loyalty accounts | present | READ SOURCE / NEVER CROSS-MUTATE |
| Append-only business loyalty ledger | present | READ SOURCE / PRESERVE |
| Reward issuance state on loyalty redemption rows | present | REUSE AS INITIAL SOURCE EVIDENCE |
| `settlement_access` consent purpose | present | REUSE |
| `access_orphan_settlement` action authorization | present | REUSE |
| `complete_settlement` action authorization | present | REUSE |
| Business / branch RBAC | present | EXTEND WITH SETTLEMENT PERMISSIONS |
| Customer QR | present | REUSE AS CONTEXT ONLY |
| Business QR | present | REUSE AS CONTEXT ONLY |
| Server-side QR action resolver | present | EXTEND |
| Community Points | locked complete | ISOLATE / DO NOT MUTATE |
| Orphan claim tables | missing | ADD |
| Settlement tables/ledger | missing | ADD |
| Partner Credits | missing | DEFER SPLIT 07 |
| Subscription compensation | legacy billing exists | DEFER SPLIT 08 |

---

## 2. Existing consent primitives are intentionally sufficient

Split 01 pre-provisioned:

```text
consent purpose:
settlement_access

short-lived customer actions:
access_orphan_settlement
complete_settlement
```

This is direct architectural evidence that settlement was expected to use:

- durable customer consent;
- scoped short-lived authorization;
- consumable high-risk action authority.

Split 06 must reuse these primitives.

Creating a second settlement-consent table would duplicate authority and violate Split 01.

---

## 3. Existing loyalty evidence

The current loyalty ledger already supports durable issued non-points reward state:

```text
loyalty_transactions.type = redemption
related_reward_id != null
issuance_status = issued
redemption_confirmed_at = null
```

This is the strongest implementation-ready source for an outstanding reward entitlement.

The source row remains business-owned historical evidence.

Split 06 adds a separate orphan claim rather than moving/copying that transaction into another business.

---

## 4. Repository conflict: raw points are not cross-business value

Current `loyalty_accounts.points` is:

- business-scoped;
- non-negative;
- backed by that business's own `loyalty_transactions`;
- governed by that business's own reward costs/policies.

Therefore:

```text
100 points at Business A != 100 points at Business B
```

Repository reality provides no authoritative cross-business exchange rate.

Any direct point transfer would invent an economic equivalence not present in the architecture.

**RULING:** Split 06 v1 does not orphan raw point balances.

---

## 5. Repository conflict: subscription cancellation cannot yet be settlement authority

Business subscription/billing infrastructure exists, but the locked roadmap defers subscription compensation and billing economics to Split 08.

A cancelled subscription may have multiple business/product meanings and must not silently become settlement authority without a locked billing contract.

**RULING:** Split 06 may recognize platform-confirmed business exit/inability-to-honor, but may not derive orphan claims automatically from subscription cancellation alone.

---

## 6. Business exit representation

Current relevant repository states include:

- business: `active | suspended | archived`;
- business-customer membership: `pending | active | suspended | left | business_exited | closed`;
- loyalty account: `active | suspended`.

These states support settlement qualification context but are not, independently, sufficient proof of a particular reward entitlement.

Claim creation must always re-resolve the source loyalty transaction.

---

## 7. Existing QR architecture compatibility

Split 03 freezes one Business QR and one Customer QR as context identifiers.

Current resolver intentionally exposes minimum necessary business-local relationship state.

Settlement is therefore additive:

- business scan may request settlement authorization;
- customer scan may discover eligible settlement action;
- server resolves eligibility;
- QR never contains claim/value/authorization truth.

No new permanent settlement QR is required.

---

## 8. Receiving-business acceptance is an architecture requirement

Settlement cannot be modeled as a customer-only redemption because another business assumes a fulfillment obligation.

Required state transition:

```text
customer authorizes access
        ↓
receiving business accepts
        ↓
reservation
        ↓
customer authorizes completion
        ↓
receiving business fulfills
```

This preserves consent on both sides and prevents involuntary cross-business liability.

---

## 9. Partner Credits are deliberately absent

Prior architecture places Partner Credits after orphan settlement.

Therefore Split 06 completion evidence may identify:

- receiving business;
- fulfilled settlement;
- policy version;
- fulfillment reference.

It may not calculate:

- Partner Credit quantity;
- subscription credit;
- invoice value.

Those are downstream decisions.

---

## 10. No architecture amendment required

The current repository is compatible with the frozen Split 06 design.

Required work is additive:

- orphan claim domain;
- orphan settlement/reservation domain;
- append-only settlement events;
- settlement business permissions;
- QR resolver actions;
- customer/business settlement routes;
- completion evidence contract;
- tests.

No locked upstream ownership model must change.

---

## 11. Quarantined / prohibited shortcuts

Do not:

- reuse `community_point_transactions` as orphan settlement ledger;
- reuse receiving `loyalty_transactions` to represent settlement;
- copy origin points to receiving points;
- derive settlement authority from QR payload;
- expose cross-business claim history before customer authorization;
- auto-accept on behalf of receiving business;
- complete without `complete_settlement` authorization;
- calculate Partner Credits;
- mutate Stripe/subscription state;
- treat PR #51 or any prior branch-loyalty/community concept as implementation authority.

---

## 12. Expected implementation sequence

1. Shared Split 06 contracts and validators.
2. Add migration `0039_split06_orphan_settlement.sql`.
3. Claim / settlement / event repositories.
4. Orphan qualification service from authoritative loyalty entitlement.
5. Customer claim read + settlement consent/access authorization.
6. Receiving-business permission and acceptance path.
7. Reservation concurrency/idempotency.
8. Customer completion authorization.
9. Receiving-business fulfillment + completion evidence.
10. Expiry/cancel/reversal handling.
11. QR action resolver integration.
12. Architecture-negative tests proving no loyalty/Community/Partner Credit/billing mutation.
13. Completion hardening and lock review.

---

## 13. Freeze decision

**ARCHITECTURE RECONCILIATION: PASS**

**ARCHITECTURE AMENDMENT REQUIRED: NO**

**IMPLEMENTATION AUTHORIZED AFTER FREEZE MERGE: YES**

The companion Split 06 v1.0 specification is implementation-ready subject to repository CI validation and merge to authoritative `main`.
