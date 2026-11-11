# B2B platform — read-only architecture reconciliation

Status: **discovery only** (no code, no schema, no endpoints, no UI). Produced alongside Community Hub H1.
Baseline: `origin/main` @ `9d92b33`. Evidence: repository source and the locked specifications under `docs/architecture/builds/`.
Financial activation remains **NO-GO**. Nothing here authorizes implementation.

## 0. Owner definition (D3) used as the yardstick
An Echo Grid-controlled business networking and collaboration system: (1) business discovery, profiles and service/resource participation; (2) approved Community Point redemption partnerships; (3) orphan reward settlement collaboration; (4) survey hosting and cross-business research; (5) approved offers and business campaigns; (6) Partner Credits and partner qualification visibility; (7) future approved subscription benefits and marketing priority services. These are **separate capabilities** with separate ledgers; no direct business-to-business editing of private customer records, loyalty balances or financial accounts. The internal Platform Admin Console is **not** the B2B platform.

## 1. What already exists (Splits 04–08)
| D3 capability | Backend today (verified) | Business/customer UI today |
|---|---|---|
| Survey hosting | Split 04: staff routes `GET/POST /surveys`, versions, pause/close, **campaigns** (list/create/activate/pause/close) under `survey:view` / `survey:manage`. Customer routes `/surveys/me/campaigns/:id`, `start`, `submit`, `participations`. Survey ownership is per business; Split 04 §4 forbids reading another business's private responses unless a later cross-business spec permits it. | **None** (no survey screens in `apps/web`). |
| Community Points | Split 05: memberships, point accounts, rules (earning source `survey_completion`, rule resource `survey_campaign`), award decisions, append-only ledger; customer `GET /community/me`, `join`, `leave`, `GET /community-points/me`, `/transactions`; platform admin rules/ledger/adjustments/suspend. | Customer read-only hub (this block, H1). |
| Orphan settlement collaboration | Split 06: customer orphan claims and settlement completion; business routes `GET /settlements`, `POST /settlements/access`, accept, fulfill under `settlement:*`; reversal and termination services. | Business screen `/dashboard/settlements`; customer `/loyalty/dashboard/settlements`. |
| Partner Credits | Split 07: `partner_program_enrollments`, `partner_credit_policies`, `partner_credit_accounts`, `partner_credit_award_decisions`, `partner_credit_lots`, `partner_credit_ledger`, `partner_credit_recovery_obligations`. Enrollment is **platform-administered** (`PartnerEnrollmentService.enroll` requires an active platform admin) with explicit business acceptance of terms. Frozen policy PC-ECON/1 (R1–R9): credits are non-cash entitlements earned by the receiving business only, never customers. | **None.** |
| Subscription benefits | Split 08: CE1 reservation/application/consumption design gates, benefit application saga and reconciliation migrations (0042–0056). Split 07 §10: credit balances/lots/eligibility may be exposed to businesses only **after the Split 08 contract freeze**. | None. Not activated. |
| Business discovery, profiles, resources/services | **Not implemented.** Split 02 explicitly defers "B2B resource/service profile → Split 09". **No Split 09 specification exists in the repository.** Only `GET /businesses/:id/public` (id, name, locale, currency, timezone, category key) and the caller's own `GET /businesses`. | None. |
| Offers and business campaigns (marketing) | **Not implemented.** The only "campaigns" are survey campaigns (Split 04) and the loyalty reward campaign detail screen (Phase 2C-3), neither of which is a B2B offer. No offer or approval entity found. | Reward campaign screen only. |
| Community Point redemption partnerships | **Not implemented.** The ledger reserves transaction type `redeem` / source `redemption`, but no Community redemption service, partner catalog or partner-redemption entity exists in `apps/api/src/community`. | None. |
| Marketing priority services | **Not implemented**; no spec or entity found. | None. |

## 2. Participation, enrollment and permission controls that exist
- Tenant isolation by business and branch; staff RBAC permissions `survey:view|manage`, `settlement:view|accept|fulfill`, `billing:manage` (partner terms/accept). Customer routes use a separate customer session.
- Partner enrollment is a platform-admin act plus business acceptance (`POST /partner-credits/consent/accept`, `billing:manage`); enrollment alone exposes no customer orphan data and creates no credits (Split 07 §5).
- Platform admin cross-tenant routes are gated by `platformRole`, not by tenant RBAC.

## 3. Business-facing read-only partner information available today
- `GET /partner-credits/consent/terms` (`billing:manage`): the published participation terms.
- `GET /businesses/:id/public`: minimal public identity only.
- **Not available**: partner credit balance, lots, recovery debt, eligibility snapshots (reserved until Split 08 freeze), partner directory, other businesses' profiles.

## 4. Missing contracts (cannot be built without new specs and authorized backend)
1. Business profile and resource/service listing entities and their visibility/consent rules (Split 09, unwritten).
2. Business discovery/directory read contract, with privacy, moderation and Echo Grid approval workflow.
3. Offer and business-campaign entities, approval states and audience rules.
4. Community Point redemption partnership: partner catalog, redemption service, partner settlement ledger (separate from business loyalty and Partner Credits).
5. Cross-business research contract (what, if anything, one business may see of another's survey data).
6. Business-facing partner credit visibility contract (post Split 08).
7. Marketing priority entitlements tied to subscription tiers.

## 5. Navigation and workspace boundaries (proposal, not implemented)
Keep four distinct workspaces: **Customer** (Loyalty, Community, QR, Settlements), **Business operations** (existing sidebar), **Business Network (B2B)** as its own section reached only for businesses enrolled by Echo Grid, and **Platform Admin Console** (internal, cross-tenant, untouched). The Network section must read only data the owning business has consented to publish and must never edit another party's records.

## 6. Financial capabilities deliberately blocked
Partner Credit issuance and award decisions beyond existing frozen foundations, credit applications and consumption, subscription fee reductions, any cross-tenant financial workflow, Stripe state changes, refund-triggered recovery, Community Point adjustments with write UI (D4: read-only), and the PC-ECON/1 numeric benefit (reserved for Split 08). Business loyalty, Community Points, orphan claims, Partner Credits and subscription billing keep separate ledgers.

## 7. Proposed implementation sequence
**Supported by existing backend (UI only, one authorized block each):**
- H1 Customer Community hub (read-only) — this block.
- H2 Customer Surveys list/participation on `/surveys/me/*` (after authorization and endpoint review; do not expose a Surveys destination before it works).
- S1 Business survey hosting screens on `/surveys` staff routes (list, versions, campaigns) under `survey:*`; no cross-business reads.
- P1 Business read-only Partner terms/enrollment status screen using `GET /partner-credits/consent/terms` (accept action only with explicit owner approval).

**Requires specification and new/changed backend (future, not authorized):**
- Split 09 specification: business profiles, resources/services, discovery, visibility and consent model.
- Community redemption partnership: partner catalog, redemption service, ledger, reversal rules.
- Offers and campaigns with approval workflow; marketing priority tied to subscription tiers.
- Partner Credit visibility and subscription benefits after the Split 08 freeze.

## 8. Decisions needed from the owner
1. Authorize writing the Split 09 specification (scope, consent and privacy model) before any B2B UI.
2. Confirm S1/P1 may proceed as UI on existing endpoints, and in which order versus H2.
3. Confirm whether Community redemption partnerships are in the next specification or deferred.
4. Confirm the position of the Network section in business navigation.
