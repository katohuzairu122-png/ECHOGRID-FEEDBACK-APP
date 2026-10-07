# ECHO GRID — SPLIT 03
## Loyalty & Core QR Interaction
### Implementation Specification v1.0

**Status:** FROZEN FOR EXECUTION  
**Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`  
**Branch:** `architecture/split-03-loyalty-qr-core`  
**Base:** Split 02 locked-complete branch @ `ce3fd9f39e34a7d6352e0325fd2ae57d50771cd5`  
**Master authority:** Echo Grid Master Architecture v1.0  
**Split:** 03 of 10

---

## 1. Purpose

Split 03 reconciles the existing loyalty engine and QR system to the locked architecture without rebuilding working economic logic.

The current repository already has:

- business-level loyalty accounts,
- append-only loyalty transaction ledger,
- denormalized point/visit projections,
- configurable loyalty settings,
- tiers,
- reward catalog/campaign rules,
- customer redemption + staff confirmation,
- signed expiring branch QR tokens,
- visit verification and anti-fraud controls.

This split preserves those strengths and fixes the missing architecture boundaries.

---

## 2. Frozen loyalty model

```text
BUSINESS CUSTOMER MEMBERSHIP
        ↓
LOYALTY ACCOUNT
        ↓
QUALIFYING EVENT
        ↓
LEDGER ENTRY
        ↓
DENORMALIZED PROJECTION
```

Economic history remains append-only.

Corrections use compensating entries.

---

## 3. Repository audit classification

### KEEP
- `loyalty_accounts` as business-level loyalty account
- `loyalty_transactions` as append-only economic ledger
- denormalized points / visit totals
- configurable loyalty settings
- tiers and reward campaigns
- two-phase redemption code confirmation
- signed expiring business QR tokens
- QR revocation/regeneration
- visit/fraud controls

### ADAPT
- purchase recording is not idempotent and has no durable purchase event/reference
- staff loyalty router currently requires business-wide access globally, preventing branch-scoped staff transaction operations
- QR token semantics still call the shared branch QR `qr_feedback`
- QR DB rows default to `type='feedback'` despite being reused for loyalty
- customer QR identity is missing
- server-side QR action resolver is missing
- customer-side business QR action resolver is missing

### DEFER
- survey actions → Split 04
- Community Points → Split 05
- orphan settlement actions → Split 06
- Partner Panel → Split 07
- billing → Split 08

---

## 4. Business QR identity

The existing physical branch QR remains the canonical Business QR context.

Do NOT create separate permanent QR codes for:

- feedback
- loyalty join
- loyalty check-in
- reward viewing

The one business/branch QR identifies:

```text
business
branch
QR identity
```

Server-side policy decides available actions.

---

## 5. Business QR token migration

Newly issued business QR tokens use:

```text
type = qr_business
```

Legacy printed tokens with:

```text
type = qr_feedback
```

must continue verifying during compatibility.

The QR row `type` should migrate from `feedback` to `business` for current general-purpose branch QR rows.

No printed QR should stop working solely because of this semantic correction.

---

## 6. Customer QR identity

Add a dynamically issued signed Customer QR token.

Properties:

- customer-authenticated issuance only,
- short-lived,
- signed,
- no loyalty balance embedded,
- no business membership list embedded,
- no rewards embedded,
- identifies only the customer and token purpose.

Recommended claim:

```text
sub = customer_id
type = qr_customer
iat
exp
nonce
sigVer
```

Use the existing QR signing secret unless implementation evidence requires a separate secret.

---

## 7. Staff scans Customer QR

Add an initial server-side action resolver.

Inputs:

```text
authenticated staff
business context
optional branch context
customer QR token
effective permissions
customer membership
loyalty account
```

Possible Split 03 actions:

```text
VIEW_ALLOWED_MEMBERSHIP_STATE
VALIDATE_PURCHASE
GRANT_LOYALTY_PROGRESS
REDEEM_REWARD
```

Only valid actions are returned.

Settlement actions are not added until Split 06.

The resolver exposes minimum necessary state, never the customer's cross-business memberships.

---

## 8. Customer scans Business QR

Add customer-side business QR action resolution.

Inputs:

```text
authenticated customer
business QR token
membership
loyalty account
reward availability
```

Possible actions:

```text
JOIN_LOYALTY
OPEN_LOYALTY_CARD
VIEW_REWARDS
CHECK_IN
LEAVE_FEEDBACK
```

Future survey/settlement actions are additive in later splits.

---

## 9. Purchase-event authority

A purchase that changes loyalty value must have durable idempotent evidence.

Add:

```text
loyalty_purchase_events
```

Minimum fields:

```text
id
business_id
branch_id nullable
customer_id
membership_id
loyalty_account_id
idempotency_key
external_reference nullable
channel
qualifying_amount
payment_status
occurred_at
created_by
created_at
```

Initial channel vocabulary:

```text
branch
online
delivery
whatsapp
phone
other
```

Initial accepted payment state for earning:

```text
confirmed
```

---

## 10. Purchase idempotency

Unique invariant:

```text
(business_id, idempotency_key)
```

Repeated same purchase request must return the already-recorded result and must not award points twice.

If the same idempotency key is reused with materially different purchase data:

```text
409 IDEMPOTENCY_CONFLICT
```

---

## 11. Loyalty transaction linkage

Add nullable:

```text
loyalty_transactions.purchase_event_id
```

New purchase-type ledger rows must reference their purchase event.

Legacy purchase rows remain valid with NULL purchase_event_id.

Do not back-invent legacy purchase references.

---

## 12. Branch attribution

Transactional staff loyalty actions may be branch-scoped.

Split 03 must stop globally requiring business-wide access for all loyalty staff routes.

Business-wide access remains required for:

- loyalty settings
- tiers
- reward configuration
- business-wide customer/account listings
- campaign dashboards where appropriate

Branch-scoped staff may perform permitted operational actions within their trusted branch context, including:

- purchase validation/recording
- redemption confirmation

The transaction records the trusted branch context when one exists.

---

## 13. Manual adjustment boundary

Manual point adjustment remains a compensating economic operation.

Do not make arbitrary adjustment equivalent to a purchase.

Adjustment continues to require explicit permission, actor, reason/notes, and ledger entry.

Future permission tightening may occur under Governance, but Split 03 must not silently broaden it.

---

## 14. Reward reservation semantics

Preserve the existing two-phase redemption design:

```text
customer claim
→ redemption code / outstanding liability
→ staff confirmation
→ redeemed
```

This satisfies the reservation-before-final-redemption architecture.

Do not collapse claim and confirmation into one action.

Existing issuance/redemption history must be preserved.

---

## 15. QR security

Neither Business QR nor Customer QR may contain authoritative:

- balances,
- rewards,
- permissions,
- cross-business memberships,
- settlement values.

Tokens identify context only.

All available actions are resolved server-side.

---

## 16. Required migration

Expected migration:

```text
0036_split03_loyalty_qr_core.sql
```

Contents:

- create `loyalty_purchase_events`
- add `loyalty_transactions.purchase_event_id`
- add indexes/FKs/checks
- migrate current `qr_codes.type='feedback'` to `business`
- change QR row default to `business`
- preserve legacy token verification compatibility

---

## 17. Required tests

### Loyalty
- same purchase idempotency key cannot earn twice
- conflicting replay is rejected
- purchase event and ledger transaction are atomic
- points projection equals expected ledger effect
- branch attribution is recorded
- active membership required
- cross-business account mutation rejected

### Business QR
- new token type is `qr_business`
- legacy `qr_feedback` tokens still verify
- revoked QR still rejected
- branch/business claim mismatch rejected

### Customer QR
- customer can obtain own short-lived token
- customer QR cannot authenticate as a different customer
- expired customer QR is rejected
- customer QR contains no balance/reward data

### Action Resolver
- branch staff only sees actions allowed by permission and membership
- Business A staff cannot resolve private Business B relationship state
- customer scanning a business with no membership sees JOIN_LOYALTY
- existing member sees OPEN_LOYALTY_CARD
- settlement/survey actions are absent in Split 03

---

## 18. Definition of Done

Split 03 is LOCKED COMPLETE only when:

- existing loyalty ledger remains intact
- purchase event authority exists
- purchase awarding is idempotent
- branch-scoped operational loyalty actions are supported safely
- current QR becomes explicit Business QR identity
- legacy printed QR compatibility remains
- Customer QR exists
- staff-side customer QR resolver exists
- customer-side business QR resolver exists
- no authoritative economic data is embedded in QR tokens
- migration drift passes
- lint passes
- security gates pass
- API/web typecheck passes
- unit/integration tests pass
- builds pass
- browser verification passes
- completion report exists

---

## 19. Conflict rule

If implementation conflicts with Master Architecture or this frozen Split 03 specification:

**STOP AND REPORT. DO NOT INVENT A WORKAROUND OR REDESIGN THE ARCHITECTURE FOR CONVENIENCE.**
