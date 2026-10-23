# Owner decisions and development authorization — 2026-10-23

**Status: owner-selected development baseline. NOT activation.** These decisions authorize architecture-compliant local development, testing, documentation and CI. They do **not** authorize production deployment, production migrations, remote Neon certification, live Stripe financial operations, or production security-configuration changes. `historicalTierVerified`, `issuanceAuthorized` and `redemptionAuthorized` remain `false`.

## 1. HETA Block G baseline (G1–G6)

| ID | Owner decision | Implementation rule |
|---|---|---|
| G1 | Canonical identity `(provider_namespace, provider_realm, origin_account_id, livemode, provider_event_id)` | Missing or unverified identity stays unresolved; independent endpoints, provenance and verification context are preserved. |
| G2 | Immutable typed comparison, dispositions `corroborated_fields`, `conflicted`, `incomparable`, `unassessed` | Arrival order or raw-byte differences alone never decide authority; corroboration is not complete history or eligibility. |
| G3 | Independent provider/account attestation, least-privilege credentials, **15-minute maximum lifetime, no grace** | Provider identity, account relationship, mode and tenant binding are separate; missing attestations are never manufactured. |
| G4 | Append-only bitemporal revocation/supersession | Effective + recorded time, monotonic revisions, expected-predecessor checks, fail-closed concurrent revision, explicit revocation/compromise states. |
| G5 | Encrypted durable receipt, then asynchronous reconciliation | A webhook acknowledgement is never financial authorization; the production webhook path is unchanged until a separate cutover. |
| G6 | Least-privilege roles (receipt writer, attestation, reconciler, tenant projection, forensic) + defense-in-depth RLS | No change to production Neon roles, credentials or Hyperdrive bindings. |

Rule: independent, non-activating components and tests only. This does not claim G1–G6 approval or provider authority.

**Note on 0045.** The existing `EVIDENCE_L2_MAX_AGE_SECONDS` is deliberately unset-by-default and fail-closed (no value is assumed). G3's 15 minutes is therefore a *proposed* value to supply at activation, not a default baked into code.

## 2. Split 07 — Partner Credit policy (PC-ECON/1)

1 PC per eligible accepted, unreversed settlement; owner is the receiving business; 10 PCs per business per UTC month; 14-day vesting; 12-month expiry; no retroactive earning, cash-out or transfer; disputed awards held until resolved; audited corrections with dual approval for financial-impacting ones.

This **matches the frozen PC-ECON/1** in `ECHO_GRID_SPLIT_07_PARTNER_LAYER_CREDITS_v1.0.md` (already implemented: awards, monthly cap, vest, expiry, reversal, recovery offsets, reservation). Not yet implemented, and tracked as work: disputed-award hold; dual-approval corrections.

## 3. Split 08 — invoice benefit policy (proposed, versioned)

1 eligible PC = 1% of the eligible invoice base charge; maximum 10% per eligible invoice; eligible = base recurring subscription charge; excluded = taxes, one-time charges, previous balances; no cross-business application; no cash equivalent; atomic idempotent reservation; consumption only on confirmed provider-side application; failed applications reconcile then release or retain; reversals append compensating entries; no retroactive adjustment.

This matches the Split 07 spec's "recommended monthly billing benefit" (1% per credit, 10% cap). **It differs from the unfrozen `PC_ECON2_*` proposals** (tiered earning 3/2/1, USD 100-cent unit, 30% cap). Those documents were never frozen; they are treated as **not adopted**. *Owner: confirm that PC-ECON/2 is superseded.*

### Rules the owner has not yet specified (development defaults, flagged)

`INVOICE_BENEFIT_ECONOMICS_PROVIDER_RECONCILIATION_FREEZE_GATE.md` lists choices that need explicit sign-off. Defaults used for **testing only**, each reversible by changing the versioned policy:

| Open choice | Development default | Why |
|---|---|---|
| Billing intervals | **monthly only**; yearly ineligible | Split 07 spec: yearly not eligible in v1 |
| Trials, free, canceled, past-due, unpaid, partially paid, no-amount-due invoices | **ineligible** (only a fully paid invoice with an amount due) | conservative; matches "not eligible in v1" |
| Rounding | **floor to whole minor units** | never grants more than the stated percentage |
| Currency | must equal the invoice currency; no conversion; none hard-coded | owner gave a percentage, not an amount |
| Proration, add-ons, Stripe discounts | proration/adjustment lines **excluded** from the base; discounts reduce the base only when the provider evidence states the discounted base amount | not eligible in v1 |
| Excess units over the 10% cap | capped; the remainder is simply not reserved | owner: maximum 10% |

## 4. Production and certification statuses

| Item | Status |
|---|---|
| Next.js security release | APPROVED FOR PREPARATION ONLY. `deploy-production.yml` is not dispatched without separate explicit authorization. |
| Migration 0047 | CONDITIONALLY APPROVED FOR PREFLIGHT ONLY. `migrate-production.yml` is not run without separate authorization; existing guards are never disabled to apply it. |
| Neon clean-replay certification (A database, B credentials, C dispatch) | PREPARATION AUTHORIZED; remote execution requires separate approval. |

## 5. Known conflicts and unresolved items found while adopting these decisions

1. **Historical-tier verification cannot be certified by code alone.** HETA-01D requires a documented *source completeness guarantee* that no provider transition was omitted, and states this deployment has not established one. Code can implement and test the certificate checks; a positive result needs an owner-approved completeness mechanism. Flags stay `false`.
2. **Multi-unit (PC-ECON/2) accounting** is not needed under the adopted single-unit policy; `0044` multi-unit tables remain inert.
3. **Disputed-award hold** needs a new award/lot state; the frozen state machine has none. Requires a reviewed additive migration.
4. **Dual approval for corrections** has no existing actor/approval model.
5. **G6 roles** cannot be created by the application migration journal without Neon role privileges; role SQL is delivered as a separately applied, tested asset.
