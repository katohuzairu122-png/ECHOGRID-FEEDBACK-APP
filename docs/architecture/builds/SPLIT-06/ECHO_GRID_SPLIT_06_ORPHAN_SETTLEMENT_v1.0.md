# ECHO GRID — SPLIT 06: ORPHAN REWARD CLAIMS & SETTLEMENT

**Status:** FROZEN FOR IMPLEMENTATION  
**Version:** v1.0  
**Architecture class:** Cross-Business Reward Settlement  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Target branch:** `main`  
**Implementation branch:** `architecture/split-06-orphan-settlement`  
**Depends on:** Splits 01–05 LOCKED COMPLETE  
**Expected migration:** `0039_split06_orphan_settlement.sql`

---

## 1. Authority

This specification reconciles Split 06 against:

- Echo Grid Master Architecture v1.0;
- Split 01 — Identity & Customer Relationship;
- Split 02 — Business & Branch;
- Split 03 — Loyalty & Core QR;
- Split 04 — Surveys & Participation;
- Split 05 — Community Points.

Locked upstream rules preserved:

1. Customers retain one global Echo Grid identity.
2. Business loyalty remains business-owned.
3. A business never mutates another business's loyalty account or ledger.
4. Community Points remain platform-owned and separate from business loyalty.
5. Orphan Reward Claims are a distinct financial/reward domain.
6. Partner Credits remain a distinct business-compensation domain.
7. Subscription Billing remains a distinct billing domain.
8. QR tokens identify context only and never carry authoritative economic truth.
9. Sensitive settlement actions require explicit customer consent and short-lived action authorization.
10. Cross-business settlement requires explicit receiving-business acceptance.

If implementation conflicts with these rules:

**STOP AND REPORT. DO NOT REDESIGN THE ARCHITECTURE FOR CONVENIENCE.**

---

## 2. Purpose

Split 06 creates the authoritative platform domain for:

- identifying qualifying outstanding rewards that have become orphaned;
- creating one orphan claim from one authoritative source entitlement;
- preserving the original business loyalty history unchanged;
- allowing the customer to access and select settlement;
- allowing an eligible receiving business to explicitly accept settlement;
- reserving one claim against one receiving business at a time;
- requiring customer authorization before final completion;
- recording fulfillment in an append-only Orphan Settlement ledger;
- exposing settlement actions through the existing server-side QR resolvers without embedding claim value in QR;
- defining a stable handoff contract for Split 07 Partner Credits.

Split 06 does **not** create Partner Credits, subscription credits, Stripe mutations, Community Point transactions, or cross-business loyalty transactions.

---

## 3. Core domain separation

Canonical model:

```text
ORIGIN BUSINESS LOYALTY
        ↓
OUTSTANDING REWARD ENTITLEMENT
        ↓
ORPHAN QUALIFICATION
        ↓
ORPHAN REWARD CLAIM
        ↓
CUSTOMER AUTHORIZATION
        ↓
RECEIVING BUSINESS ACCEPTANCE
        ↓
SETTLEMENT RESERVATION
        ↓
CUSTOMER COMPLETION AUTHORIZATION
        ↓
RECEIVING BUSINESS FULFILLMENT
        ↓
APPEND-ONLY ORPHAN SETTLEMENT LEDGER
```

Prohibited model:

```text
Business A loyalty points
        ↓
copied into Business B loyalty points
```

Also prohibited:

```text
Orphan Claim
   ↓
Community Point balance
```

and:

```text
Settlement
   ↓
Partner Credit / subscription money
```

inside Split 06.

---

## 4. What is an orphan reward

An orphan reward is a **valid outstanding business reward entitlement that the originating business can no longer honor under an approved platform orphaning condition**.

Initial approved orphaning conditions:

- origin business is archived/exited from the platform;
- platform has explicitly determined the business is unable to honor qualifying outstanding rewards;
- a later locked integration supplies another approved reason.

A customer's ordinary departure from a loyalty program does not automatically orphan value.

A temporary branch outage does not automatically orphan value.

A business suspension does not automatically orphan value unless platform settlement policy explicitly marks the outstanding entitlement eligible.

Subscription cancellation must **not** automatically create orphan claims in Split 06. Subscription/billing interpretation belongs to Split 08 and may later provide an authoritative orphaning trigger.

---

## 5. Initial authoritative source entitlement

Split 06 v1 starts from the repository's existing durable reward-issuance history.

An initial orphanable entitlement is a `loyalty_transactions` row that:

- belongs to the customer and origin business through its loyalty account;
- has `type = 'redemption'`;
- references a concrete `related_reward_id`;
- represents a non-points reward entitlement;
- has `issuance_status = 'issued'`;
- has not already been fulfilled/redeemed;
- remains valid under the source reward's historical issuance terms;
- belongs to an origin business currently qualified for orphaning.

The original transaction remains immutable.

The claim stores the source transaction ID and an immutable snapshot of the relevant reward terms for later audit.

---

## 6. Raw business loyalty balances are not orphan claims

A business loyalty point balance is denominated in that business's own loyalty program.

Therefore Split 06 v1 explicitly prohibits:

- copying origin-business point balances into another business;
- converting Business A points directly into Business B points;
- treating two businesses' point units as equivalent;
- automatically converting a positive loyalty account balance into an orphan claim;
- using the origin `points_cost` as a receiving-business settlement value.

This is required by the locked isolated-ledger architecture.

If future product policy wants to preserve raw unredeemed point balances when a business exits, that requires a separately frozen platform valuation/conversion contract and an explicit architecture amendment.

---

## 7. Orphan claim source of truth

Add:

`orphan_reward_claims`

Minimum fields:

- `id`
- `customer_id`
- `origin_business_id`
- `origin_membership_id` nullable
- `origin_loyalty_account_id`
- `origin_loyalty_transaction_id`
- `origin_reward_id` nullable
- `orphan_reason`
- `status`
- `source_reward_type`
- `source_reward_snapshot` — immutable narrow audit snapshot
- `created_at`
- `qualified_at`
- `settled_at` nullable
- `expired_at` nullable
- `reversed_at` nullable

Required uniqueness:

```text
(origin_loyalty_transaction_id)
```

One source entitlement may produce at most one orphan claim.

Initial statuses:

- `available`
- `reserved`
- `settled`
- `expired`
- `reversed`
- `cancelled`

The claim row is a current-state projection.

It does not replace the append-only settlement event ledger.

---

## 8. Orphan Settlement ledger

Add:

`orphan_settlement_events`

This is the authoritative settlement history.

Minimum fields:

- `id`
- `claim_id`
- `settlement_id` nullable
- `customer_id`
- `event_type`
- `origin_business_id`
- `receiving_business_id` nullable
- `receiving_branch_id` nullable
- `actor_user_id` nullable
- `customer_action_authorization_id` nullable
- `idempotency_key`
- `metadata` narrowly scoped, non-authoritative
- `created_at`

Initial event vocabulary:

- `orphan_created`
- `partner_selected`
- `partner_accepted`
- `settlement_reserved`
- `completion_authorized`
- `settlement_fulfilled`
- `settlement_expired`
- `settlement_cancelled`
- `settlement_reversed`

The ledger is append-only.

No event may mutate business loyalty or Community Points.

---

## 9. Settlement attempt / reservation authority

Add:

`orphan_settlements`

Minimum fields:

- `id`
- `claim_id`
- `customer_id`
- `receiving_business_id`
- `receiving_branch_id` nullable
- `status`
- `access_authorization_id`
- `accepted_by_user_id` nullable
- `accepted_at` nullable
- `completion_authorization_id` nullable
- `completion_authorized_at` nullable
- `fulfilled_by_user_id` nullable
- `fulfilled_at` nullable
- `expires_at`
- `idempotency_key`
- `created_at`
- `updated_at`

Initial statuses:

- `proposed`
- `accepted`
- `reserved`
- `completion_authorized`
- `fulfilled`
- `cancelled`
- `expired`
- `reversed`

At most one active reservation may exist for a claim.

Historical failed/expired attempts remain readable.

---

## 10. Two-party acceptance rule

Settlement is never unilateral.

Required parties:

1. customer;
2. receiving business.

Canonical handshake:

```text
customer has available orphan claim
        ↓
customer selects/approaches receiving business
        ↓
customer grants scoped settlement access
        ↓
receiving business inspects minimum authorized claim data
        ↓
receiving business ACCEPTS
        ↓
claim becomes reserved
        ↓
customer authorizes completion
        ↓
receiving business fulfills
        ↓
settlement marked fulfilled
```

A business scan alone cannot settle a claim.

Customer consent alone cannot force a business to accept a claim.

Receiving-business acceptance alone cannot complete a claim without current customer completion authorization.

---

## 11. Customer consent and authorization reuse

Split 01 already provides the required authority primitives.

Reuse consent purpose:

`settlement_access`

Reuse short-lived action types:

- `access_orphan_settlement`
- `complete_settlement`

Do not create a second settlement-consent system.

### Access authorization

`access_orphan_settlement` must be scoped to:

- customer;
- receiving business;
- claim or authorized claim set;
- correlation ID;
- short TTL.

It permits only the minimum claim data required to decide whether the receiving business will accept.

### Completion authorization

`complete_settlement` must be scoped to:

- customer;
- receiving business;
- settlement ID;
- claim ID;
- short TTL.

It is single-use and consumed transactionally with final fulfillment.

Expired/revoked/consumed authorization cannot complete settlement.

---

## 12. Receiving-business acceptance

Split 06 requires explicit business authority.

Recommended new business permissions:

- `settlement:view`
- `settlement:accept`
- `settlement:fulfill`

These are ordinary tenant/branch-scoped permissions, not platform permissions.

A receiving business may only:

- inspect claim data explicitly authorized to it;
- accept an eligible claim for itself;
- fulfill a settlement it accepted;
- view its own settlement history.

It may never:

- read the customer's unrelated cross-business loyalty history;
- mutate the origin business ledger;
- mutate the customer's Community Point ledger;
- create Partner Credits in Split 06.

Branch-scoped acceptance/fulfillment must use trusted branch context when the receiving business operates by branch.

---

## 13. Settlement offer / fulfillment contract

Cross-business settlement cannot assume that origin and receiving loyalty units have equivalent value.

Therefore the receiving business must accept an explicit **settlement fulfillment contract** for the claim.

Minimum frozen rule:

- the customer must be shown what the receiving business will actually fulfill;
- the receiving business must explicitly accept that fulfillment obligation;
- the fulfillment contract is snapshotted on the settlement before final customer completion authorization;
- the contract may reference an approved receiving-business settlement offer or structured benefit;
- it must not write to the receiving business's normal loyalty account or loyalty transaction ledger merely to represent settlement;
- it must not use origin-business point units as receiving-business point units.

The exact platform equivalence/offer policy may be versioned, but fulfillment must fail closed if no approved policy/offer can resolve the claim.

---

## 14. Partner Credits boundary

Partner Credits are **not** part of Split 06.

Split 06 may emit a stable, immutable settlement-completion evidence contract after fulfillment.

Recommended evidence:

`OrphanSettlementCompletionEvidence v1`

Minimum fields:

- `settlementRef = orphan_settlements.id`
- `claimId`
- `customerId`
- `originBusinessId`
- `receivingBusinessId`
- `receivingBranchId` nullable
- `fulfilledAt`
- `fulfillmentPolicyVersion`
- `fulfillmentReference` nullable

It must not contain:

- Partner Credit amount;
- subscription discount amount;
- invoice mutation;
- Stripe identifier;
- Community Point amount.

Split 07 may consume this evidence to evaluate Partner Credits.

Split 06 does not perform that evaluation.

---

## 15. Subscription / billing boundary

Split 06 must not:

- create subscription credits;
- modify `business_subscriptions`;
- modify Stripe state;
- reduce invoices;
- determine billing compensation;
- convert settlement into money.

A later Split 08 flow may consume Partner Credit evidence under its own locked contract.

---

## 16. Community Point boundary

Community membership is not required to access an orphan claim.

Orphan settlement is independent of Community Points.

Split 06 must not:

- debit Community Points;
- credit Community Points;
- convert a claim to Community Points;
- require Community membership;
- use Community balance as settlement eligibility;
- write `community_point_transactions`.

Community Points remain untouched.

---

## 17. Origin business loyalty boundary

The origin business loyalty ledger remains immutable history.

Creating/settling an orphan claim must not:

- delete the source redemption;
- rewrite source points;
- create a compensating entry in another business ledger;
- attach the receiving business to the origin loyalty account.

If source entitlement state needs a one-way historical marker such as `issuance_status = 'reversed'` or another terminal state, that change must be explicitly reconciled with the existing loyalty issuance semantics and must never rewrite the substantive original transaction.

The orphan claim + settlement ledger is the cross-business source of truth.

---

## 18. Orphan qualification transaction boundary

Claim creation must be transactional:

1. re-resolve authoritative source loyalty transaction;
2. verify origin account/customer/business ownership;
3. verify source entitlement is still outstanding;
4. verify approved orphaning condition;
5. lock source entitlement/claim uniqueness scope;
6. insert orphan claim;
7. append `orphan_created` event;
8. commit;
9. only then emit non-authoritative notifications/jobs.

Retries return the existing claim.

A conflicting source mapping fails.

---

## 19. Settlement reservation transaction boundary

Receiving-business acceptance must be transactional:

1. validate active customer access authorization;
2. validate receiving business/branch eligibility and staff permission;
3. lock claim;
4. confirm claim status is `available`;
5. validate current fulfillment offer/policy;
6. create/update settlement attempt to accepted/reserved;
7. set claim projection to `reserved`;
8. append acceptance/reservation events;
9. commit.

Competing acceptance attempts cannot reserve the same claim twice.

---

## 20. Settlement completion transaction boundary

Final fulfillment must be transactional:

1. validate receiving staff permission/context;
2. lock claim and settlement;
3. validate settlement remains reserved/eligible;
4. consume scoped `complete_settlement` customer authorization;
5. record fulfillment snapshot;
6. mark settlement `fulfilled`;
7. mark claim `settled`;
8. append `completion_authorized` and `settlement_fulfilled` events as appropriate;
9. commit;
10. only then emit `OrphanSettlementCompletionEvidence v1`.

No Partner Credit or billing mutation occurs in this transaction.

---

## 21. Expiration, cancellation, reversal

### Expiration

Reservation expiry:

- releases the claim back to `available` if the source claim remains valid;
- appends `settlement_expired`;
- never deletes attempt/history.

Claim expiry:

- moves claim to `expired`;
- must follow explicit platform policy;
- does not rewrite origin loyalty history.

### Customer cancellation

Before fulfillment, customer may cancel/revoke settlement access/reservation under policy.

Cancellation:

- appends `settlement_cancelled`;
- releases the claim if still valid;
- preserves all history.

### Reversal

A fulfilled settlement may only be reversed under explicit platform authority and evidence.

Reversal:

- appends `settlement_reversed`;
- never deletes the fulfilled event;
- cannot directly reverse Partner Credits or billing because those do not exist in Split 06.

Later splits must define compensation/reversal propagation separately.

---

## 22. QR integration

Preserve the single QR architecture.

### Business scans Customer QR

The initial resolver must not leak whether the customer has orphan claims merely because staff scanned the QR.

Possible action:

`REQUEST_ORPHAN_SETTLEMENT_ACCESS`

This action means only that the staff member/business is capable of settlement and may request customer authorization.

After the customer issues `access_orphan_settlement`, the server may expose only the minimum authorized claim/settlement data.

### Customer scans Business QR

The customer-side resolver may expose:

`SETTLE_ORPHAN_REWARD`

only when:

- the customer owns an available claim;
- the receiving business is currently eligible for settlement;
- current policy allows settlement there.

No QR token contains:

- claim ID;
- origin business history;
- reward value;
- settlement offer;
- Partner Credit;
- subscription benefit;
- authorization result.

All actions resolve server-side.

---

## 23. Suggested API surfaces

Customer:

- `GET /api/v1/orphan-claims/me`
- `GET /api/v1/orphan-claims/me/:claimId`
- `POST /api/v1/orphan-claims/:claimId/select-partner`
- `POST /api/v1/orphan-claims/:claimId/authorize-access`
- `POST /api/v1/orphan-settlements/:settlementId/authorize-completion`
- `POST /api/v1/orphan-settlements/:settlementId/cancel`

Receiving business/staff:

- `POST /api/v1/settlements/access`
- `POST /api/v1/settlements/:settlementId/accept`
- `POST /api/v1/settlements/:settlementId/fulfill`
- `GET /api/v1/settlements`

Platform:

- orphan qualification/reversal/admin inspection surfaces as required by implementation;
- no Partner Credit/billing mutation surfaces in Split 06.

Exact route naming may adapt to repository conventions; authority boundaries may not.

---

## 24. Suggested schema

Additive Split 06 schema:

1. `orphan_reward_claims`
2. `orphan_settlements`
3. `orphan_settlement_events`

Expected migration:

`0039_split06_orphan_settlement.sql`

Existing tables reused without repurposing:

- `customers`
- `businesses`
- `branches`
- `business_customer_memberships`
- `loyalty_accounts`
- `loyalty_transactions`
- `loyalty_rewards`
- `consent_grants`
- `customer_action_authorizations`

---

## 25. Required tests

### Orphan qualification

- valid outstanding issued entitlement can create one claim;
- already fulfilled/redeemed entitlement cannot orphan;
- non-existent source rejected;
- wrong customer/business/source mapping rejected;
- source entitlement cannot create duplicate claims;
- inactive source reward catalog state does not erase already-issued historical entitlement;
- raw loyalty point balance does not automatically create a claim;
- subscription cancellation alone does not create a claim in Split 06.

### Consent / authorization

- no business can inspect claim details without scoped customer authorization;
- `settlement_access` consent does not itself complete settlement;
- access authorization expires;
- access authorization is receiving-business scoped;
- completion authorization is settlement scoped;
- consumed/revoked/expired completion authorization fails;
- authorization cannot be reused for another claim/business.

### Receiving business

- explicit acceptance required;
- staff permission required;
- branch scope enforced;
- Business B cannot accept on behalf of Business C;
- competing businesses cannot reserve same claim;
- acceptance does not mutate any loyalty balance.

### Settlement

- customer selection alone does not settle;
- business acceptance alone does not settle;
- completion requires customer authorization;
- fulfillment creates append-only settlement event;
- exact replay is idempotent;
- conflicting replay rejected;
- expired reservation releases eligible claim;
- cancellation preserves history;
- settlement completion evidence deterministic by `settlementRef`.

### Isolation

- origin `loyalty_transactions` substantive fields unchanged;
- receiving business `loyalty_accounts` unchanged;
- receiving business `loyalty_transactions` unchanged;
- Community Point account unchanged;
- `community_point_transactions` unchanged;
- no Partner Credit row exists;
- no subscription/Stripe mutation.

### QR

- Customer QR contains no claim/value/settlement data;
- Business QR contains no claim/value/settlement data;
- staff scan does not reveal orphan existence before authorization;
- customer-side resolver exposes settlement action only when server eligible;
- unauthorized business never receives cross-business claim history.

---

## 26. Definition of Done

Split 06 is LOCKED COMPLETE only when:

- orphan claim source authority is explicit;
- raw business point balances remain non-transferable;
- one source entitlement creates at most one claim;
- orphan settlement ledger is append-only and authoritative;
- customer consent/action authorization is reused from Split 01;
- receiving-business acceptance is explicit;
- final completion requires current customer authorization;
- only one active reservation exists per claim;
- origin and receiving loyalty ledgers remain untouched;
- Community Points remain untouched;
- completion evidence for Split 07 is stable and deterministic;
- Partner Credits remain unimplemented;
- subscription/Stripe effects remain unimplemented;
- QR contains no settlement economic truth;
- migration drift passes;
- fresh PostgreSQL replay passes;
- permission seed passes;
- API/web typecheck passes;
- unit/integration tests pass;
- API/web builds pass;
- browser verification passes;
- completion report is merged to `main`.

---

## 27. Explicitly deferred

### Split 07 — Partner Layer / Partner Credits

Deferred:

- Partner Credit account/ledger;
- settlement-to-Partner-Credit policy;
- partner compensation rates;
- Partner Panel;
- partner benefit catalog.

### Split 08 — Billing / subscription compensation

Deferred:

- subscription credit application;
- invoice offsets;
- Stripe adjustments;
- accounting reconciliation;
- billing reversal propagation.

Split 06 only emits immutable settlement-completion evidence.

---

## 28. Frozen conflict rulings

### Ruling A — orphan claims are not Community Points

No conversion or shared balance.

### Ruling B — raw business points are not transferable

No Business A points → Business B points mapping.

### Ruling C — initial source is an outstanding issued reward entitlement

This is the repository's current durable, implementation-ready source.

### Ruling D — receiving business must accept

No forced settlement.

### Ruling E — customer must authorize both access and completion

Reuse Split 01 consent/action authorization.

### Ruling F — no Partner Credits in Split 06

Split 07 consumes settlement completion evidence.

### Ruling G — no billing effects in Split 06

Split 08 owns subscription/Stripe interpretation.

### Ruling H — subscription cancellation is not an automatic orphan trigger yet

Without Split 08's authoritative billing contract, Split 06 must fail closed rather than infer billing meaning.

### Ruling I — QR remains context only

No claim/value/authorization truth embedded in QR.

---

## 29. Lock declaration

**ECHO GRID SPLIT 06 — ORPHAN REWARD CLAIMS & SETTLEMENT v1.0 IS FROZEN FOR IMPLEMENTATION.**

Implementation may refine internal technical details only where the ownership model, consent model, two-party acceptance model, append-only settlement history, ledger isolation, QR boundary, and later-domain separation above remain intact.
