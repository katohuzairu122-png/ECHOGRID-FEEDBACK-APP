# HETA-01G — Independent Architecture, Security and Economic Acceptance Gate

**Status:** Independent review framework and preliminary design assessment; **NOT implementation approval**.  
**Base:** `main` @ `12dbfdce3aaa9c720f094a3f5b3f417600202aed` (HETA-01E merged).  
**Dependency:** HETA-01F is independently proposed in PR #131, **not merged or accepted as implementation** at drafting time. This PR is intentionally independent and must be revisited after final disposition of HETA-01F.

## 1. Scope and disposition

Review the whole historical-tier evidence chain: HETA-01B authenticated immutable capture and authoritative identity binding; HETA-01C Stripe effective-time semantics; HETA-01D completeness and interval certification; HETA-01E twenty adversarial tests; HETA-01F additive migration/rollback/disposable-PostgreSQL readiness. This document records review questions, preliminary design findings, evidence demands and sign-off owners. It does not claim that the runtime controls, real Stripe configurations, E01–E20, database protections or completeness evidence have been independently validated.

**Initial finding:** Design layering is coherent but materially incomplete for implementation authorization. **Gate status: HOLD.**

## 2. Independent architecture gate

- Confirm Split 06 remains source of actual orphan settlement `fulfilledAt` and reversal facts. No billing or HETA service may redefine fulfillment.
- Confirm Stripe event inbox and verified business/customer/subscription/account/mode bindings sit in billing/HETA evidence ownership, not a new authority embedded in Partner Credits or client-facing APIs.
- Confirm current `business_subscriptions` is only a mutable operational mirror, migration 0043 observations remain append-only but are not full capture or tier-effective time. New schemas require additive compatibility.
- Confirm only HETA-01D-approved provenance/coverage rules could eventually produce historical intervals, and separately owned Split 07 must still decide earning eligibility after its own gate.
- Confirm Split 08 owns provider-authoritative invoice eligibility, Growth/Business redemption policy (proposed PC-ECON/2-A01), application and terminal credit consumption; do not contaminate PC-ECON/1 or Community Points/loyalty ledgers.
- No actor may bypass the existing 0041/0042/0044 financial write denials. A green CI suite or merged document cannot imply entitlement to disable them.

**Architecture findings requiring closure:** exact change-source coverage including external Stripe Dashboard/Portal/API/schedules; materialized transition semantics; stable Price-to-plan mapping; subscription replacement across businesses; event inbox/0043 coexistence; independent consumer contract.

## 3. Security gate

Require independently reproducible evidence for raw-body Stripe signature validation, authenticated event durability and provider account/mode scoping, conflict-digest handling, restricted unattributed quarantine, immutable append-only processing decisions and least-privilege retention controls. A signed event claiming `metadata.businessId` is not sufficient for tenant attribution. Validate application RBAC and database RLS for at least two independent businesses and branches, privileged service scopes, logging/redaction, replay idempotency and abuse controls. Show database-commit failure does not falsely acknowledge capture.

**Security blockers:** HETA-01B logical inbox/binding/quarantine are not yet implemented or validated; E01–E20 are design-only. No positive tenant-specific historical tier authority can pass today.

## 4. Provider semantics and completeness gate

Provider documentation is background, not proof of ECHO GRID's account configuration. Require a tested inventory of enabled Stripe mutation paths and permission holders (Checkout, Portal, Dashboard, external API, subscription schedules); prove which authoritative executed operation establishes each exact price-effective boundary. Never use `event.created`, receipt time, checkout request time, item period boundary or intended future schedule phase as universal authority. Pending invoice-dependent updates must use actual applied transition proof, not intent. HETA-01D coverage anchors must prove no relevant intervening transitions through the Split 06 fulfillment instant, handle true precision/order ties and reject gaps, overlaps, ambiguity, unsupported multi-item or superseded evidence.

**Provider/blocker:** No verified complete provider-derived historical interval source currently established. Positive `historicalTierVerified` remains denied.

## 5. Economic and accounting gate

- Authenticate the exact business, settlement eligibility, `fulfilledAt`, provider tier and effective economic policy version. No issuance upon a subscription webhook itself.
- Protect PC-ECON/1 as distinct from proposed PC-ECON/2 economics (Starter 3, Growth 2, Business 1 units earned per qualifying settlement; other tiers subject to separate policy). No award quantity repricing from later upgrade/downgrade.
- The PC-ECON/2-A01 proposed redemption minimum is Growth/Business; earning is not invoice redemption. Split 08 still requires separately verified eligible provider invoice and application.
- No SQL trigger weakening, ledger mutation, provisional credit, reservation, award, Stripe write, subscription fee discount or fund transfer in this acceptance-design PR.

**Economic blocker:** Neither historical tier certification nor issuance/redemption acceptance is implemented or separately authorized. Preserved migrations 0041/0042/0044 are hard no-write barriers.

## 6. Independent evidence checklist and decision record

| Gate | Mandatory evidence | Present status |
| --- | --- | --- |
| A. Source/boundary reconciliation | Mainline code/schema baseline, domain ownership review | Design evaluated; no implementation approval |
| B. Stripe effective-time proof | Account configuration, test provider receipts, precise source-specific semantics | **OPEN** |
| C. Completeness proof | Immutable captured transitions, trusted coverage, supersession and gaps | **OPEN** |
| D. Identity and RLS | Cross-business account/customer/subscription binding and negative isolation tests | **OPEN** |
| E. Migration compatibility | 0043 coexistence, proposed additive DDL, role/RLS, rollback, upgrade tests | **OPEN** |
| F. Adversarial E01–E20 | Disposable PostgreSQL deterministic actual-path results and audit artifacts | **OPEN** |
| G. Economic protection | Guard introspection and forbidden-write rejection under test roles | Existing guards documented; new path not tested |
| H. Review sign-offs | Named independent architecture, security, economic reviewers and written findings | **OPEN** |
| I. Explicit owner authorization | Separate implementation approval, then distinct activation authorization | **NOT GRANTED** |

Decision record template for each reviewer: reviewer role/identity, reviewed branch SHA and specifications, evidence IDs/CI runs, findings and severity, accepted mitigations, recommendation `APPROVE | HOLD | REJECT`, date and owner decision. A model/agent consistency assessment is not a submitted human GitHub review or independent governance approval.

## 7. Review challenges for the next executable phases

Require red-team review to identify: metadata identity spoofing, stale projection regression, missing mid-period transition, Stripe provider/account-mode mismatch, unsupported multiple subscription items, contradictory digest replay, missing signed events due to webhook outage, external Dashboard edits not captured, inconsistent concurrent binding/certification snapshots, superseded certificates, invalid Price-to-plan mapping, and independent failure of the database economic guards. Include documented stop/recovery mechanisms, append-only evidence conservation and no production financial test operations.

No merge, code change or new migration may follow automatically from HETA-01G. If PR #131 changes, update this review before sign-off. Once all gates are evidenced, a separate scope-specific implementation request and approval remain required.

## 8. Preliminary independent design review conclusion

**No architectural conflict identified in the intended HETA-01B–01F separation** that would prevent documentation of this gate. However, the provider-effective-time, coverage completeness, immutable capture, identity-binding, SQL/RLS compatibility, test execution and human sign-off questions remain **material unresolved blockers**. This review therefore recommends **HOLD** for implementation and economic activation, not acceptance.

**Stopping point:** Documentation-only HETA-01G review contract. No executable tests, migrations, production changes, financial writes or automatic merge.
