# S08 D1/D3-DEV-03 — Consumption Settlement Gate (development record)

Status: DEVELOPMENT ONLY, INERT. Financial activation: NO-GO. Mock/synthetic evidence only.

## What it does
Partner Credit consumption (`PartnerCreditConsumptionService.consume`) now requires, inside its transaction and before any write, a persisted
settlement authorization for the reservation whose **newest** snapshot is ELIGIBLE, intact, fresh, and bound to the business, reservation, decision,
invoice, Stripe account, mode, policy version and the persisted frozen allocation. Replays of an already consumed credit return before the gate.

## Components
- Table `partner_credit_settlement_authorizations` (migration 0060): append-only (UPDATE/DELETE/TRUNCATE denied, ENABLE ALWAYS), unique on
  (reservation, snapshot digest), composite FK to the reservation, CHECKs (verdict/reason coherence, `MOCK_SYNTHETIC` kind only, hex digests).
  BEFORE INSERT trigger recomputes the canonical digest and checks reservation/decision/invoice/policy/allocation binding.
- `partner_credit_ledger` BEFORE INSERT trigger: a `consume` entry needs the newest authorization of its reservation+decision to be ELIGIBLE (defence in depth).
- `SettlementAuthorizationRecorder.record`: takes evidence only (never a verdict), locks the reservation, runs the pure classifier (`classifySettlement`), persists the result.
- `requireSettlementAuthorization`: the gate; re-reads and re-verifies everything under the consumption locks. Lock order unchanged (recorder locks only the reservation).
- Freshness uses the DATABASE clock; the window is configuration with no default. Allowed intervals default to `['month']` as a restrictive DEVELOPMENT default, not approved policy.

## Not done / blocked on owner decisions
No Stripe field mapping beyond the mock contract (Q1/Q2), no Q14 effective timestamp, no refund-triggered recovery, no annual invoices, no R10 executor.
Authenticity of evidence rests on write restrictions (inert guards, role hardening F-5): a writer with INSERT privilege could store a row the classifier never computed.
The gate stays unconfigured (fail-closed) unless a `SettlementGateConfig` is supplied.
