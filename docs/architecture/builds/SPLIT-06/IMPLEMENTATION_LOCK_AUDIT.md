# ECHO GRID — SPLIT 06 IMPLEMENTATION LOCK AUDIT

**Status:** PASS — LOCK CANDIDATE  
**Split:** 06 — Orphan Reward Claims & Settlement  
**Architecture:** `ECHO_GRID_SPLIT_06_ORPHAN_SETTLEMENT_v1.0.md`  
**Baseline:** authoritative `main` after PR #76 / Block 8  
**Purpose:** final implementation reconciliation, hardening, negative-boundary audit, and lock evidence.

---

## 1. Audit conclusion

Split 06 implementation is architecture-conformant after the completion-hardening patch in this branch.

The final hardening pass identified two implementation gaps against the frozen specification:

1. the existing Split 03 QR action resolvers had not yet been extended with Split 06 settlement actions;
2. the receiving-business settlement-history read surface was absent.

Both are closed by this lock candidate without changing ownership, ledger, consent, authorization, settlement, or downstream-domain boundaries.

No architecture amendment is required.

---

## 2. Authoritative implementation chain

| Phase | PR | Merge commit | Result |
| --- | ---: | --- | --- |
| Architecture freeze | #68 | `07ee8e1b6afc827328ca468a165148d5d2531b65` | Split 06 v1.0 frozen |
| Block 1 — contracts/schema/repositories | #69 | `8f539cef1d17afd37e5163fdbab83f0e9450178e` | foundation complete |
| Block 2 — authoritative qualification | #70 | `bf1f55831f15fac9bb58b2aaafabb892a19c8770` | qualification complete |
| Block 3 — customer claim/access | #71 | `f5106869f8a62d9e6d3cc18a9cda48a75bb7b9ab` | customer access complete |
| Block 4 — business acceptance/reservation | #72 | `b4aa60d1cb6cc5ad591fa587bb582d75b89fc27b` | acceptance complete |
| Block 5 — customer completion authorization | #73 | `4d271d45ceda6ca2748f8d7baf77f8d148a25b34` | completion authority complete |
| Block 6 — fulfillment/evidence | #74 | `24f9e24bee8950870ccb23e498d8c968ebde6cbf` | terminal fulfillment complete |
| Block 7 — expiry/cancellation/release | #75 | `ec902092a999a57c86398010405b792e3b85c899` | non-happy-path release complete |
| Block 8 — reversal/evidence invalidation | #76 | `9df9e2c87b862ce5dffb7660690877a56307ede3` | reversal complete |

This lock candidate adds only completion hardening and lock documentation.

---

## 3. Source authority and claim uniqueness

**PASS**

Authoritative source remains an existing business-loyalty `loyalty_transactions` redemption row representing an outstanding issued non-points reward entitlement.

Implemented invariants:

- source transaction is re-resolved and locked before qualification;
- customer/origin-business ownership is re-resolved through the source loyalty account;
- source must be `type='redemption'`;
- source must be `issuance_status='issued'`;
- source must remain unconfirmed/unfulfilled;
- a concrete reward reference is required;
- points-type rewards are rejected;
- one source loyalty transaction can create at most one orphan claim;
- source loyalty history is not rewritten by orphan settlement.

Raw loyalty account point balances remain non-transferable and are not an orphan-claim source in v1.

---

## 4. Domain isolation

**PASS**

Split 06 remains separate from:

- origin business loyalty;
- receiving business loyalty;
- Community Points;
- Partner Credits;
- subscription billing;
- Stripe.

Verified implementation behavior:

- no receiving loyalty account is created merely to represent settlement;
- no receiving loyalty transaction is written by settlement;
- origin loyalty substantive history remains unchanged;
- no Community Point account/ledger mutation occurs;
- no Partner Credit schema, row, amount, or calculation exists in Split 06;
- no subscription or Stripe mutation occurs.

---

## 5. Consent and customer-action authorization

**PASS**

Split 01 primitives are reused rather than duplicated.

Access path:

`settlement_access` consent + `access_orphan_settlement` short-lived authorization.

Completion path:

`complete_settlement` short-lived authorization scoped to customer, receiving business, settlement, and claim.

Implemented properties:

- receiving business cannot inspect minimum claim data without active scoped access authority;
- access authority is consumed only when business acceptance/reservation succeeds;
- completion authority remains active after customer authorization;
- completion authority is consumed transactionally with receiving-business fulfillment;
- revoked/expired/consumed or cross-scoped authority fails closed;
- exact replay is idempotent.

---

## 6. Two-party settlement handshake

**PASS**

Implemented lifecycle:

```text
qualified orphan entitlement
        ↓
available orphan claim
        ↓
customer chooses receiving business
        ↓
customer grants settlement access
        ↓
receiving business inspects minimum authorized data
        ↓
receiving business explicitly accepts
        ↓
claim + settlement reserved
        ↓
customer reviews exact fulfillment contract
        ↓
customer authorizes completion
        ↓
receiving business fulfills
        ↓
claim settled / settlement fulfilled
        ↓
completion evidence
```

Neither side can unilaterally complete settlement.

---

## 7. Reservation concurrency and branch authority

**PASS**

- claim and settlement rows are locked during acceptance/fulfillment transitions;
- only one active accepted/reserved/completion-authorized settlement may exist per claim;
- competing businesses cannot reserve the same claim;
- receiving branch context is taken from trusted tenant middleware;
- a branch-bound reservation cannot be fulfilled or replayed from another branch.

Completion-hardening adds receiving-business history reads that also use trusted branch context:

- business-wide staff can read the business's settlement history;
- branch-scoped staff see only that branch's settlements;
- no request-body branch identifier controls history scope.

---

## 8. Append-only settlement history

**PASS**

`orphan_settlement_events` remains append-only.

Implemented event vocabulary:

- `orphan_created`
- `partner_selected`
- `partner_accepted`
- `settlement_reserved`
- `completion_authorized`
- `settlement_fulfilled`
- `settlement_expired`
- `settlement_cancelled`
- `settlement_reversed`

Repository exposes no event update/delete path.

Projection transitions and event append occur within the same transaction where required; conflict tests prove rollback.

---

## 9. Fulfillment evidence and reversal

**PASS**

`OrphanSettlementCompletionEvidence v1` is deterministic by `settlementRef` and contains only the identifiers/policy references required for trusted downstream evaluation.

It contains no:

- Partner Credit amount;
- subscription credit;
- invoice mutation;
- Stripe identifier;
- Community Point amount;
- cross-business loyalty value.

Block 8 adds platform-admin-only fulfilled settlement reversal with explicit reason/evidence, append-only `settlement_reversed`, semantic audit logging, and deterministic reversal evidence.

After reversal:

- original `settlement_fulfilled` event remains;
- completion evidence is explicitly invalidated;
- reversal evidence becomes authoritative;
- no downstream Partner Credit or billing reversal is executed by Split 06.

---

## 10. Expiry and cancellation

**PASS**

Pre-fulfillment cancellation and reservation expiry:

- preserve settlement history;
- revoke still-active settlement authorizations as appropriate;
- release a reserved claim only after revalidating that its source entitlement remains releasable;
- fail closed rather than recreating invalid value.

### Claim expiry policy

The frozen architecture states that claim expiry must follow **explicit platform policy**.

No claim-expiry policy/version is frozen in Split 06 v1. Therefore the implementation intentionally does **not** invent automatic claim expiry.

A reservation that expires while its underlying entitlement is no longer safely releasable is left blocked for explicit future platform policy/admin handling.

This is a policy deferral, not an implementation omission.

---

## 11. QR architecture

**PASS after completion hardening**

The existing Split 03 single Customer QR / single Business QR resolver is extended additively.

### Business scans Customer QR

Possible action:

`REQUEST_ORPHAN_SETTLEMENT_ACCESS`

Rules:

- emitted only when staff has `settlement:view`;
- resolver does **not** query whether the scanned customer owns orphan claims;
- therefore action presence cannot leak orphan-value existence;
- no claim ID/value/settlement/authorization data is returned.

### Customer scans Business QR

Possible action:

`SETTLE_ORPHAN_REWARD`

Rules:

- receiving business must currently be active;
- customer must own at least one `available` orphan claim;
- claim must originate from a different business;
- no claim ID/value/settlement ID/authorization result is embedded in QR or resolver output.

All authority continues to be resolved server-side after the action is selected.

---

## 12. Receiving-business history

**PASS after completion hardening**

`GET /api/v1/settlements` is implemented under:

- staff authentication;
- trusted tenant resolution;
- `settlement:view`.

The response is limited to receiving-business settlement projection data and does not expose origin loyalty history.

Branch-scoped requests are constrained to the trusted branch.

---

## 13. Required-test reconciliation

### Qualification

PASS:

- valid source qualifies;
- nonexistent/redeemed/confirmed/expired/points source rejected;
- wrong customer/business mapping rejected;
- inactive catalog state does not erase issued historical entitlement;
- duplicate source is idempotent;
- source loyalty and Community ledgers remain unchanged.

### Consent / authorization

PASS:

- no claim inspection without scoped customer authority;
- receiving-business scope enforced;
- revoked/expired access fails;
- completion authority settlement/claim scoped;
- revoked/expired/consumed completion authority fails;
- cross-settlement idempotency conflicts rejected.

### Receiving business

PASS:

- explicit acceptance;
- RBAC permission;
- branch scope;
- cross-business isolation;
- competing reservation exclusion;
- no loyalty mutation;
- receiving settlement history branch isolation.

### Settlement

PASS:

- selection alone does not settle;
- acceptance alone does not settle;
- customer completion authorization required;
- terminal event append;
- exact replay;
- conflicting replay rollback;
- expiry releases still-valid reserved claim;
- cancellation preserves history;
- completion evidence deterministic by `settlementRef`;
- reversal preserves fulfilled history and invalidates completion evidence.

### QR

PASS after hardening:

- QR tokens contain no settlement economic truth;
- staff resolver does not reveal orphan ownership;
- customer resolver exposes settlement action only when server eligible;
- unauthorized receiving business never gains cross-business claim history.

---

## 14. Completion-hardening changes

This lock candidate adds:

1. `REQUEST_ORPHAN_SETTLEMENT_ACCESS` to the existing staff-side Customer QR resolver.
2. `SETTLE_ORPHAN_REWARD` to the existing customer-side Business QR resolver.
3. an efficient available-orphan eligibility lookup that excludes the scanned origin business.
4. `GET /api/v1/settlements` for receiving-business settlement history.
5. trusted branch scoping for that history query.
6. unit coverage for QR non-leakage and customer eligibility.
7. real-Postgres coverage for branch-scoped settlement-history isolation.
8. this implementation lock audit and the Split 06 completion report.

No migration is required.

---

## 15. Architecture-negative audit

No evidence was found of:

- raw business point transfer;
- origin → receiving loyalty conversion;
- orphan → Community Point conversion;
- Partner Credit creation;
- subscription credit creation;
- Stripe mutation;
- QR-embedded claim/value/authorization truth;
- receiving-business mutation of origin loyalty;
- business-side bypass of customer completion authority;
- customer-side forced business acceptance.

---

## 16. Lock decision

**ARCHITECTURE CONFORMANCE:** PASS  
**IMPLEMENTATION COMPLETENESS:** PASS after this hardening candidate  
**ARCHITECTURE AMENDMENT REQUIRED:** NO  
**MIGRATION REQUIRED:** NO  
**SAFE TO LOCK AFTER FULL CI:** YES

Final lock requires the repository's complete CI/CD gate and merge of `COMPLETION_REPORT.md` to authoritative `main`.
