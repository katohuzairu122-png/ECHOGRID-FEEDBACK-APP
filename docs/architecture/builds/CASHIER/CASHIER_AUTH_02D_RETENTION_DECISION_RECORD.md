# CASHIER-AUTH-02D: retention and erasure owner decision record (2026-11-19)

Status: **DECISION REQUIRED. Nothing here selects a retention period or changes deletion behaviour.** Baseline: `main` @ `fe9c5e897ff627ec3c5e2dee5a49682875f98a5c`.

## 1. What is already approved (and what is not)

| Source | Position |
|---|---|
| `docs/OPERATIONS.md` "Data retention" | "Not yet configured as an explicit policy." Soft-delete is used and nothing purges. `audit_log` is append-only and its business and user references are `ON DELETE SET NULL`. No right-to-erasure flow exists; flagged as a pre-launch gap if the target jurisdiction requires one. |
| CUSTOMER-AUTH 01B (D-B1, D-B2) and the roadmap | Retention for dead sessions and events, and the IP policy, are **open** and need owner and legal input. No number is proposed there. |
| CASHIER-AUTH-02 decision record | No retention ruling for onboarding evidence. |

Conclusion: **no retention period or erasure rule is approved for any 02D data class.**

## 2. Data classes introduced or used by 02D

| Class | Where | Personal data? | Mutability today |
|---|---|---|---|
| Onboarding attribution event (business, branch, source, cashier actor, customer, membership, verification state, is_rejoin, timestamps) | `customer_onboarding_events` | Yes (links a customer to a branch and a cashier) | Append-only: UPDATE, DELETE and TRUNCATE are denied by trigger; all seven foreign keys are RESTRICT |
| Consent evidence (JOIN_LOYALTY grant and version) | existing consent records referenced by the event | Yes | Existing consent behaviour; the event requires a matching grant |
| Customer identity reference | `customer_id` in events, memberships | Yes | RESTRICT: blocks hard delete of the customer while events exist |
| Cashier actor reference | `cashier_user_id` in events, `audit_log.user_id` | Yes (staff personal data) | RESTRICT in events; `SET NULL` in audit_log |
| Invitation issuance evidence | `audit_log` row `loyalty.onboarding_invite_issued` (cashier, session, branch, no customer) | Staff only | Append-only audit trail |
| Single-use evidence | unique index on (business, reference) in the event table; invitation id | No | Same as the event |
| Security and replay evidence | rate-limit and `RATE_LIMITED` audit rows; refresh-token rows | Partly (IP, device) | Refresh rows expire; no purge job |

Not stored: the invitation token, any customer data inside the invitation, any cashier-entered customer detail.

## 3. The conflict to resolve before production

Because the events are append-only with RESTRICT foreign keys, a hard delete of a customer, cashier, membership, branch or business is **blocked while events exist**. There is no erasure flow today, so there is no present
breach, but a future erasure obligation cannot be met without a decision and a reviewed migration.

## 4. Options

| Option | Effect | Dependencies | Consequences |
|---|---|---|---|
| A. Retain permanently, document the legal basis | No change; events kept for attribution reporting | Legal basis and consent wording confirmed | Erasure requests for customers or cashiers cannot be fulfilled by deletion |
| B. Fixed retention period, then audited anonymisation of `customer_id` and `cashier_user_id` | Counts survive; personal links removed | Period chosen by owner and legal; reviewed migration adding a narrow, audited exception to the append-only guard; nullable columns or tombstone ids | Schema change, careful guard design, tests |
| C. Fixed retention period, then deletion | Rows removed | Same, plus loss of historical counts | Reporting history lost |
| D. Anonymise on request only (erasure-driven) | Personal links removed when a customer or cashier is erased | Erasure flow (not built), identity verification | Needs a product flow |

**Recommendation (not a decision):** B for the customer link on request or at the end of a defined period, and keep cashier references while the cashier account exists, with the owner setting the period and the legal basis.
It is the only option that keeps the attribution counts the feature exists to produce.

## 5. Evidence that must be preserved regardless

Security-relevant evidence (audit rows for issuance, revocation and authority changes, replay and rate-limit events) should keep its approved audit retention; do not purge it as part of any attribution erasure.

## 6. Required owner inputs

1. Legal basis and retention period (or "none") for onboarding events.
2. Erasure treatment (A to D) and who executes it.
3. Whether the current consent wording covers recording branch, cashier and source.
4. Retention for refresh-token and security rows.

**No production activation of 02D until these are decided.** Staging is unaffected.

## 7. Evaluation of Options A to D (added 2026-11-19; no option is approved)

Criteria: privacy, consent, append-only events, audit integrity, RESTRICT keys, erasure workflows, retention expiry, security investigations, consistency.

| Criterion | A. Keep permanently | B. Anonymise after a period or on request | C. Delete after a period | D. Anonymise on request only |
|---|---|---|---|---|
| Customer privacy | Weakest: personal link is permanent | Strong: link removed, counts kept | Strongest | Strong only for those who ask |
| Consent records | Consent and event stay paired | Consent evidence must be kept or anonymised in step (decision needed) | Consent link broken or also deleted | As B, per request |
| Append-only guard | Unchanged | Needs a narrow, audited exception to the guard and a reviewed migration (nullable `customer_id` / `cashier_user_id`, adjusted CHECKs) | Same exception, plus deletion | Same as B |
| Audit integrity | Intact | Audit rows kept; event-to-audit link stays valid (the audit row holds no customer data) | The audit row would point at a removed event | As B |
| RESTRICT foreign keys | Block hard delete of customer, cashier, branch or business while events exist | Anonymised rows no longer reference the person, so deletion unblocks | Deletion unblocks | Unblocks only after anonymisation |
| Erasure workflow | Cannot be met by deletion | Can be met | Can be met | Can be met, but needs an erasure flow that does not exist today |
| Retention expiry | None | Automatic after the owner's period | Automatic after the period | None |
| Security investigations | Best | Keeps branch, source, timestamps and counts; loses who | Worst | As B for those erased |
| Database consistency | No change | Higher risk (guard exception, nullable columns, tests) | Highest (history gaps) | As B |

**Recommendation:** Option B as the mechanism, with the owner choosing the trigger (request only, a fixed period, or both). It is the only option that serves erasure and keeps the attribution counts the feature exists for. Option A is acceptable only if the owner documents a legal basis and
confirms that no erasure obligation applies to this data. No period is proposed here and none should be assumed.

**Exact decision required from the owner** (answer each):
1. Which option (A, B, C or D)?
2. If B, C or D: the trigger and any period, set by the owner with legal input (or "on request only").
3. The documented legal basis for recording branch, cashier and source, and confirmation that the consent wording covers it.
4. Which fields an anonymisation clears (recommended: `customer_id` and `cashier_user_id`; keep business, branch, source, timestamps) and whether consent evidence is anonymised with it.
5. Who runs it, and approval for a separate, reviewed migration (number to be allocated at that time) and tests.
Until answered, no deletion, anonymisation or retention job is implemented.
