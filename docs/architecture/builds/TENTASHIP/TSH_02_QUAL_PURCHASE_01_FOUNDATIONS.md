# TSH-02 and QUAL-PURCHASE-01: referral and purchase qualification foundations (Batch 03 groups C, D)

Status: IMPLEMENTED, validation pending hosted CI. Migration 0097 (additive, not applied to any shared database). EVIDENCE FOUNDATION ONLY: nothing here awards, pays or enters anyone into anything, and **final qualification is disabled**: no rule is approved and no route approves one.

## Roadmap reconciliation
TSH-01 section 4 defines the closed declarative rule engine; TB-02 implemented its single-metric badge form. This block adds the SHARED engine (one spec format for Badges, Shuffle and Drops: no second engine), referral attribution (TSH-01 section 5) and canonical purchase evidence. Customer-referral links do not exist in the repository; none is created here.

## Shared qualification engine (`apps/api/src/qualification`)
Closed schema: combinator ANY / ALL / AT_LEAST n over 1..8 pathways; metrics `recorded_purchases` and `referral_attributed`; whole-number thresholds; optional `minAmount` (exact decimal STRING, max 2 decimals) which REQUIRES a `currency`; optional window; `sinceAttribution`; `referralTypes` (default customer referrals only). No expressions or code. Evaluation is a pure deterministic function; a missing measure counts as nothing (fail closed). Specs are canonically hashed.
Rule versions (`qualification_rule_versions`): immutable content; INSERT is draft; the only forward move is approval (stamping who and when) or retirement; one approved version per key; no DELETE/TRUNCATE. **No route approves a rule.** Approval is the Owner's policy act; until it happens nothing can qualify in production.
Evidence consumption (`qualification_evidence_consumptions`): unique per evidence, rule version and consumer kind: a purchase can never qualify twice under the same rule.

## Referral attribution (`customer_referrals`, `customer_referral_events`)
- Types: `business_invitation` (a business-owned acquisition channel, recorded automatically in the join transaction of an owner-issued or cashier-assisted invitation) and `customer_referral` (needs a referrer distinct from the referred; **no public path creates one**: the trusted service entry exists and enforces identity rules for the future link mechanism). Organic and unattributed acquisition have NO row.
- One attribution per referred customer, ever (database unique): no re-attribution, no reassignment. Attribution is append-only (no update/delete/truncate). Evidence stores `newToPlatform` and prior-purchase facts at attribution time.
- Lifecycle (database-validated, append-only events): attributed -> pending_qualification -> verified; outcomes expired, rejected, invalidated, revoked, fraud_review (resolves back to pending or to a terminal outcome). A verified referral can only be revoked or invalidated by a NAMED actor (no automatic retroactive revocation).
- `verified` needs an APPROVED customer rule version (database trigger): with none, **no referral can ever be verified**. Verification measures server evidence under a per-referral lock, consumes it, and writes one `verified` event; concurrent callers collapse to one.
- A business invitation never qualifies as a customer referral unless an approved rule explicitly lists `business_invitation`.
- Link clicks, QR scans, invitation creation, unverified registration and client events are never evidence.

## Purchase evidence (QUAL-PURCHASE-01)
Reuses `loyalty_purchase_events` (no new POS or ledger). Levels: recorded purchase / verified transaction evidence / financially settled / qualifying purchase are DISTINCT; the strongest the platform can honestly claim today is **recorded** (an authorised cashier entered it; no external settlement evidence exists). Counted: `payment_status = confirmed`; refunded and reversed are excluded, but **no current flow ever sets refunded or reversed**, so reversal exclusion is only as reliable as that status (Owner decision D05/D06). Amounts compare as exact SQL `numeric`, only within the business's own currency; other currencies are never compared; no universal minimum exists.

## Verification (local, PostgreSQL 16)
22 unit tests for the closed schema and evaluation; 10 integration tests (attribution rules, lifecycle guards, fail-closed qualification, exclusions, exact decimals, single consumption, 6-connection concurrency, append-only); migration 0095 -> 0097 upgrade with legacy, badge and closure data preserved byte-for-byte, rollback evidence (`rollback/0096_0097_rollback.sql`) and re-apply; tenant-reference pre-check clean; runtime-role manifest drift check clean.

## Owner decisions (not invented)
D02 verified referral definition; D03 qualifying purchase definition and thresholds/currencies; D04 the referral qualifying event (recommended: first recorded qualifying purchase after attribution); D05 purchase evidence level required (recorded vs a settlement integration); D06 invalidation/reversal treatment, including badge consequences; and whether and how a customer referral link is ever offered. Until approved, runtime execution stays disabled and technical development can continue.
