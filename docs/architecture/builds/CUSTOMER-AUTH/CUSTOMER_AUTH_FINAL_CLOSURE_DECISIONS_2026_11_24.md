# Echo Grid Customer Authentication — Final Closure Decisions

Date: 2026-11-24  
Baseline: `c398a5e64445422922d779d4004e3ea2d1c97063`  
Scope: D01–D06 implementation reconciliation; development and isolated tests only.

This record translates the owner's approvals into repository behavior. Approval does not substitute for the acceptance evidence listed in the final certificate. No shared environment flags, providers, databases, or schedules are changed by this record.

## D01 — A–H acceptance contract

Approved domains: registration, email verification, password login, session security, account recovery, QR and customer identity continuity, authorization/isolation/abuse protection, and localization/accessibility. The existing R5 contract document is now marked owner-approved. Its prior provisional browser fixture still does not cover every scenario; uncovered tests remain blockers and are not counted as passes.

## D02 — existing rate-limit architecture

Approved rule: preserve limits already enforced; fail closed when a mandatory limiter is unavailable; do not promote illustrative values from the old 01D-5 proposal to policy. Current code-defined budgets observed at this baseline are:

| Surface | Existing enforced budget | Key dimensions | Failure behavior / note |
| --- | --- | --- | --- |
| Email registration and email-link delivery | 10/source/hour and 3/normalized identifier/hour | trusted source + keyed email identifier | Generic accepted response; limiter/provider failures do not disclose account state. |
| Password login, legacy OTP session, email-link completion | 5/source/15 minutes and 5/normalized identifier/15 minutes | trusted source + keyed submitted identifier | Generic invalid-credential response. Login identifier is email for password login and phone for legacy OTP. |
| Password change | Existing 5/source/15-minute and shared credential-change ceiling, plus 5/customer/15-minute | trusted source + preserved shared identifier + independently derived authenticated customer key | New account dimension preserves previous ceilings and isolates customers. Missing live session identity fails before the mutation. |
| Recovery initiate, email challenge, phone OTP | 10/source/hour and 3/customer/hour | source + customer | Fail closed; SMS/email delivery failures stay generic. |
| Recovery email verify, phone factor, recovery code verify, completion | 5/source/15 minutes and 5/customer/15 minutes | source + customer | Fail closed; attempts/proofs are separately single-use or capped. |
| Recovery cancellation | 10/source/hour and 5/attempt+source/15 minutes | source + attempt | Cancellation cannot restore consumed factors or sessions. |
| Customer phone attach | 5 OTP requests/customer/day; 10 failed checks/customer/day; OTP route limiter 3/minute; 60-second same-number cooldown; six-digit code expires in 10 minutes with 5 attempts | authenticated customer + phone-keyed OTP limiter/cooldown | Wrong/expired proofs are denied; unique verified-phone constraint fails duplicates closed. |
| Ordinary customer API routes | 60/customer/minute | authenticated customer | In addition to endpoint-specific policy. |
| Existing business-owner/admin authentication | `AUTH_RATE_LIMITER` 10/minute; public lookup 300/minute; lookup 20/minute; OTP 3/minute; follow-up OTP 5/minute; follow-up question 10/minute | Cloudflare fixed-window bindings; OTP keys are route-specific | These shared bindings are preserved; no customer-specific budgets are inferred from unrelated surfaces. |

The repository's `CUSTOMER_AUTH_RATE_LIMIT_DIMENSIONS` module defines an additional proposed six-surface scheme (including an OTP global spend ceiling), but its own source and design note state it is not mounted and its Cloudflare bindings are not declared. Its example numbers are explicitly illustrative. They are therefore not represented as enforced or approved limits. The source also does not establish a separate global SMS spend ceiling or a verified end-customer source address behind the web Worker. Those operational controls require an explicit future numerical/trust decision before relying on that proposed module. Existing deployed OTP route limiter remains 3/minute; no attempt budget was raised.

Related challenge protections, separate from request throttles: registration email proofs expire after 900 seconds, allow at most 5 failed proof attempts, and suppress same-email re-issuance for 60 seconds; email-link proofs expire after 900 seconds, suppress same customer/email re-issuance for 60 seconds, and cap at 3 live proofs per customer. SMS OTPs expire after 600 seconds, allow 5 attempts, and enforce a 60-second same-number cooldown. Recovery challenge and attempt bounds are listed in the table above. Provider-side Twilio spend limits are external to this repository and were not verified.

Executable coverage remains required for the actual route compositions and bindings. Unit tests of the isolated limiter implementation alone do not establish deployed binding behavior.

## D03 — pending-registration retention

Expired registration ciphertext is eligible at the existing challenge `expires_at` boundary; no additional grace period is added. Successful proof consumption already clears the sealed payload in the activation transaction. The cleanup primitive uses bounded batches, transactional row locks with `SKIP LOCKED`, nulls only expired registration ciphertext, and is idempotent. Synthetic disposable-PostgreSQL tests were added. No automatic production schedule or extra audit-retention duration is configured. Challenge proof/audit metadata and completed customer history are not removed by this cleanup.

## D04 — cancellation after recovery-code consumption

A consumed code remains consumed after cancellation. Cancellation is terminal for that attempt; proofs do not reactivate, revoked sessions do not return, and a subsequent attempt must satisfy fresh factors. Integration coverage checks consumption, cancellation, replay denial, and a cancellation/completion race. Existing security-hold behavior remains in force.

## D05 — changed or recycled phone risk

Verified-phone replacement is currently unsupported and remains blocked by the existing `PHONE_CHANGE_NOT_SUPPORTED` behavior. The repository has no authoritative recycled-number signal and no approved recency threshold. Therefore production recovery does not classify an old phone as low risk based on an invented seven-day threshold: absent an explicitly configured approved threshold, phone-assisted recovery is high risk and subject to the existing 24-hour hold. A positive recycled-number signal cannot be evaluated until an approved source exists; until then phone possession is not sufficient alone and the existing multi-factor requirements remain. No new threshold or signal has been invented.

## D06 — provider and operational readiness

Development tests use the existing transactional email and Twilio Verify adapters, synthetic mailbox/SMS implementations, disposable databases, and signed/trusted attribution. No live verification or recovery message was sent, and no live provider configuration was read or changed. Synthetic tests can establish accept/reject/error handling and proof secrecy; they cannot establish real deliverability, provider account readiness, live webhook behavior, or operational alerting.

## Activation boundary

`CUSTOMER_EMAIL_AUTH_ENABLED` and `CUSTOMER_LEGACY_UPGRADE_ENABLED` remain disabled in shared environments. This change does not edit production/staging environment configuration, secrets, or databases; it does not deploy, merge, or schedule cleanup.
