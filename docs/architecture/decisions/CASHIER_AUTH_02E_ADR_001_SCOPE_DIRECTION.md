# ADR-CASHIER-02E-001: CASHIER-AUTH-02E scope direction (owner decision D8)

- **Date:** 2026-11-19
- **Status:** ACCEPTED as a high-level direction (owner directive "CASHIER-AUTH-02E E1 DEVELOPMENT", 2026-11-19)
- **Repository:** `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`
- **Baseline:** `main` @ `51c8357` (PR #527 merged)

## Decision

CASHIER-AUTH-02E is the **full acceptance and verification phase** for the already implemented CASHIER-AUTH-02A to 02D modules. Its purpose is to establish reproducible evidence of correct behaviour, close verified acceptance gaps,
document approved security mitigations and prepare release-readiness evidence. **It is not a new cashier feature-development phase.**

Sequence:

| Block | Purpose |
|---|---|
| E1 | Repeatable staging acceptance harness |
| E2 | Close outstanding acceptance-test gaps |
| E3 | Implement separately approved security mitigations |
| E4 | Consolidate the production-readiness and release runbook |

## What this decision does NOT approve

Approval of this direction is not approval of any unspecified policy, production operation or additional feature. Still open and unchanged:

- D1 attribution-secret presence in each Worker; D2 retention and erasure; D3 deliberate-lockout mitigation; D6 production migration and release bundle.
- A **test mailbox** for verification codes: not approved.
- The **three staging hostnames** for live harness execution: derived from repository configuration, **not yet explicitly approved** (see the harness configuration, which ships with `approved: false`).
- E2, E3 and E4 implementation; production deployment, migrations, DNS, secrets and data changes.

## Consequences for E1

E1 ships the harness **disabled for live execution by default**. Live runs need the reviewed configuration file to record the owner's approval of the hostnames; OTP-dependent scenarios need a separately approved mailbox. Until then those scenarios are
reported NOT RUN and the harness is verified by local tests only.
