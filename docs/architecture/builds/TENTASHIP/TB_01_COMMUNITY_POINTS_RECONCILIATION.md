# TB-01 — Community Points reconciliation, Tenta Badges achievement architecture and migration design

Status: DESIGN ONLY. Baseline main `1af1d5b`. No schema, data, route or UI change. Production balances and row counts were NOT read (no production access in this block): **UNKNOWN**.

## 1. What exists today (verified in source)

Schema `apps/api/src/db/schema/community-points.ts`:

- `community_memberships` (one per customer; statuses active/left/suspended/inactive; policy version, joined/left/suspended timestamps).
- `community_point_accounts` (one per customer; status active/suspended/closed; integer `points_balance`).
- `community_point_rules` (versioned; status draft/active/paused/retired; `points > 0`; only source `survey_completion`, resource `survey_campaign`).
- `community_point_award_decisions` (pending_membership/awarded/rejected/reversed; unique per source+rule).
- `community_point_transactions` (types earn/redeem/reverse/expire/admin_adjustment; unique idempotency key; unique reversal-of; check constraints on signs and reversal linkage).

Services/routes: award (`community-point-award.service.ts`, survey completion only), reversal, admin adjustment, rule admin; customer `GET /community-points/me`; platform `/platform/community-point-rules`, `/platform/community-point-ledger`, `/platform/community-points` (adjustments). Web: `/loyalty/dashboard/community` hub view and `lib/community-hub*.ts`.

Observed behaviour: the only earning source is survey completion; no code path writes `redeem` or `expire` transactions (types exist in constraints only); there is no points-to-money, transfer or cash-out path; Community controls (join/rejoin/restore/clearance, feed, pilot) are not set in any config, so live points data is expected to be empty or minimal — **unverified**.

Separate, unrelated systems that must not be conflated:

- **Business loyalty points** (`loyalty_accounts`, `loyalty_transactions`, `loyalty_settings`): business-scoped balances, tiers, rewards. Includes the existing referral mechanism: `loyalty_accounts.referred_by_customer_id`, `loyalty_settings.referral_bonus_points` (default 50), transaction type `referral_bonus`. These are existing customer entitlements and stay untouched.
- Deletion-request and pilot-eligibility guards (migrations 0089/0090) already protect Community records during account deletion and gate enrollment.
- Web push/notification infrastructure exists (WEB-PUSH build, notification code in the API) and is reusable for badge/invitation notices.

## 2. Reusable vs missing

Reusable: membership + consent gating, versioned rules pattern, idempotent transaction pattern, reversal linkage, admin adjustment audit, customer deletion guards, pilot control, notifications, business-scoped referral attribution fields.
Missing: achievement/milestone model, qualification rule engine, cross-business aggregates, referral verification and fraud signals, campaign/inventory/allocation, independent feature controls.

## 3. Findings

1. "Community Points" are an integer balance with a ledger; Tenta Badges are achievements. They are different concepts and must not be merged by relabeling.
2. Converting balances to badges would rewrite entitlements; the legacy ledger is append-only evidence with check constraints.
3. Customer-facing copy that says "Community Points" exists today; any rename needs an Owner decision on how legacy balances are described.

## 4. Proposed migration strategy (recorded before any implementation; nothing irreversible)

- **Preserve the legacy ledger unchanged** (tables, endpoints, history, balances). No deletion, no silent conversion, no rewrite.
- **Add a separate, additive achievement ledger** for Tenta Badges: badge definition (versioned, immutable once active), customer/business badge award (idempotent, with evidence reference, reversal linkage, no balance field, no transfer fields). Badges carry no monetary, redemption, cash-out, wager or Shuffle-purchase semantics.
- **Compatibility mapping**: read-only; legacy points remain visible as historical "Community Points (legacy)" until the Owner decides otherwise; the API contract `/community-points/me` and platform routes remain.
- **Survey-completion points**: may additionally emit a badge only through the future engine, never by rewriting past transactions.
- **Communication**: any change in how customers see legacy points needs explicit customer notice drafted and approved by the Owner and legal.
- **Controls**: `TENTA_BADGES_ENABLED` (independent, default off); schema changes (if approved) are additive migrations with their own rollback evidence, applied only on Owner instruction.

## 5. Risks

Silent entitlement change; double counting between legacy points and badges; badges perceived as currency (regulatory and consumer-law exposure); referral fraud (self/duplicate/circular, refund abuse); cross-tenant attribution leaks; deletion interplay (badges tied to deleted customers); unknown production data volume.

## 6. Owner decisions required

- **D-1** Legacy Community Points: keep as-is read-only, keep earning, freeze earning, or retire — and how customers are told.
- **D-2** Badge ledger shape: per-customer and per-business awards; whether badges expire or can be revoked; reversal rules (D-5).
- **D-6** Minimum group size for any aggregated badge or acquisition statistic.
- Whether any badge ever unlocks a Shuffle qualification only (recommended) and never a purchase or stake.

## 7. Acceptance for TB-01 (this block)

Documented reconciliation, strategy and decisions; no behaviour change; existing tests unchanged and passing; no protected identifier modified. Next: TSH-01 (qualification architecture) can begin as a design block after D-1/D-2 are answered, or in parallel as design only.
