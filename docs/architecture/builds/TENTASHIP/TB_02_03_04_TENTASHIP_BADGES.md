# TB-02 / TB-03 / TB-04: Tentaship Badges (Pre-staging batch 02)

Status: IMPLEMENTED, validation pending hosted CI. Migration 0095 (additive, not applied to any shared database). `TENTASHIP_BADGES_ENABLED` is OFF everywhere; no configuration sets it. Shuffle and Drops are not implemented.

## Rulings applied (TB-01 D-1, D-2; TSH-01 section 4)
- Separate achievement ledger. Legacy Community Points, business loyalty points, rewards and history are untouched: no conversion, no reinterpretation, no deletion. Proven by integration tests (balances, transaction counts and decision rows identical before/after an award) and by the TB-04 byte-for-byte upgrade test.
- A badge is not money: no balance, amount, price, currency, transfer, redemption, cash-out, wager or entry field exists (schema test + UI test).

## TB-02 Foundation (migration 0095)
| Table | Role | Integrity |
|---|---|---|
| `tentaship_badge_definitions` | canonical identity (key, participant type) | append-only |
| `tentaship_badge_definition_versions` | versioned, IMMUTABLE content (names en/ar/es/fr, descriptions, closed-schema rule, rule hash) | draft -> active -> retired only; one active per definition (partial unique index); no DELETE |
| `tentaship_badge_awards` | append-only award ledger with verified evidence | unique per (definition, participant) and (definition, evidence); composite FKs bind version to definition and participant type to the definition |
| `tentaship_badge_revocations` | append-only approved revocations (<= 1 per award) | reason codes closed; award row never changed |
All four have TRUNCATE denial (`network_truncate_denied()`), are in the runtime-role manifest (RUNTIME; no DELETE/TRUNCATE; awards/revocations/definitions have no UPDATE) and `ENABLE ALWAYS` triggers.

Rule engine (`badge-rules.ts`): declarative `{metric, threshold, windowDays?}`, strict, no expressions. **Implemented metrics** use verified server evidence only: `community_survey_completions` (customer; currently-awarded survey decisions) and `published_business_posts` (business; moderated publications, not suspended). **Blocked metrics** (refused at creation and activation with the reason): verified referrals, qualifying purchases, distinct-business purchases, acquisition, retention: the Owner has not approved their definitions (TSH-01 section 5), and cashier-recorded purchases are exactly the evidence that could be farmed.

Control: `TENTASHIP_BADGES_ENABLED` exact `"true"` only; absent/false/TRUE/1/whitespace/anything else = closed. Server-side, fail-closed, independent of every Community control and of future Shuffle/Drops controls. Gate runs BEFORE authentication on every badge route (customer, business, platform): generic 404, nothing written. Not in any wrangler config (structural test).

## TB-03 Award engine and experience
- Server-side evaluation only (`POST /tentaship-badges/me/evaluate`, `/business/evaluate`): no request input is read. Evidence is read from server-owned tables written by already-authorised flows.
- Duplicate/replay protection by database constraints; concurrent evaluations serialised by an advisory lock (8 parallel calls -> 1 award, 1 audit row). A new rule version never rewrites an earlier award (award keeps the version and rule hash). A revoked award is never re-issued.
- Approved revocation (`POST /platform/tentaship-badges/awards/:id/revoke`, platform admin, reason code + note, audited, idempotent). Award history for audit (`GET /platform/tentaship-badges/awards`).
- Authorization: customers read/evaluate only their own; businesses only their own via the business-wide hub guard; platform admin administers definitions. No cashier route exists (cashier allow-list matrix + structural test: no loyalty/cashier module references the engine, so a cashier transaction cannot award a badge).
- UI: a "Tentaship Badges" section on the customer Community hub and on the business Community home, rendered ONLY while the control is open (closed = renders nothing). Four languages including Arabic. Verified in Chromium closed (default) and open (opt-in) states.

## TB-04 Migration and compatibility acceptance
- Upgrade 0093 -> 0095 on a disposable database seeded with legacy customers, businesses, loyalty points, Community Points accounts, rules and decisions: all legacy rows byte-identical; only the five new tables added (empty, guarded); the ledger works post-upgrade.
- Rollback evidence `rollback/0094_0095_rollback.sql` (NOT executed on any shared database): removes exactly the added objects, leaves legacy data and the 0093 schema as they were; the upgrade re-applies afterwards.
- Compatibility reader: the existing `/community-points/me` contract and "Community Points (legacy)" display are unchanged; no write path to legacy tables was added.
- PostgreSQL 18: NOT RUN locally (16 only); the repository's PG18 acceptance workflow is the intended venue.

## Open Owner decisions (not invented)
1. Definitions of a verified referral and a qualifying purchase (unlocks the blocked metrics and referral/purchase badges).
2. Whether and when to activate `TENTASHIP_BADGES_ENABLED` in any environment; which first badge definitions to publish (names, thresholds, four-language copy needs legal/brand review).
3. Customer-facing wording for legacy Community Points versus badges; deletion/anonymisation of customer-linked awards (CUST-DEL-03 remains on hold; awards reference customers with ON DELETE RESTRICT, so nothing erases them).
4. Treatment of business badges when a business closes (BIZ-CLOSE-01 processing is blocked).
5. Revocation authority beyond platform admin, and customer notification of an award/revocation (no notification is sent by this block).
