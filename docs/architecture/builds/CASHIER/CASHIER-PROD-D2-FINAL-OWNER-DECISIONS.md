# D2-FINAL / R8-G consolidated Owner decision package (2026-11-20)

**Every decision below is OPEN. Nothing is approved. A recommended default is a proposal with consequences, not a ruling.** Where approval is missing the infrastructure exists but the sensitive operation is disabled or unassigned. Legal questions need qualified review; this document is not legal advice. Technical completion is not compliance.

| ID | Decision | Recommended default | Consequence of the default | Blocks |
|---|---|---|---|---|
| **R1** Retention | Purpose-based criteria and periods per data category | Define a period per purpose (onboarding analytics, loyalty/financial records, consent proof, security/audit, sanctions) with the legal basis recorded; start with **no automatic deletion** until each is approved. Use `retention_preview_onboarding_events(N)` to see the effect of a candidate N. Financial and security evidence periods need legal approval | Policies stay disabled; data is kept indefinitely until a period is approved (indefinite retention is itself a risk to be closed) | enabling any retention policy |
| **R2** Erasure triggers | What starts an erasure | Verified eligible customer requests, plus retention expiry once R1 is approved | Requests are handled one by one by an operator; no automatic erasure | real-customer erasure |
| **R3** Cashier attribution | Keep or sever the cashier on onboarding events | Sever when no longer needed for an approved purpose (fraud/accountability window); keep cashier-account activity in the audit log under its own retention | Per-request flag today (`sever_cashier`, default false); per-policy flag in the registry | cashier handling in retention runs |
| **R4** Re-identification | Small-group threshold, time and branch granularity | Aggregate-only reporting with an **explicit threshold you approve** (the mechanism exists; none is applied), day-level times, optional cashier-breakdown removal | Analytics unchanged until a threshold is set; small businesses remain identifiable in current reports | applying suppression in the analytics route |
| **R5** Authorized operator | Who runs privacy requests and how identity is verified | A dedicated, auditable **platform privacy operator** (separate login, separate from the application runtime and the migrator), with two people (verifier and a different admin approver); verify through the customer's authenticated re-authentication or an out-of-band process you define | Operator role has **no members** today; nobody can run anything | every privacy operation |
| **R6** Customer deletion | Scope of "delete my account" | The shell anonymization implemented here (identifiers removed, ledgers and consent kept pseudonymous), coordinated with sessions and notifications; decide per item: feedback contact fields, message bodies, sanction reasons, referral links | Defaults: contact scrub and conversation deletion are **off** unless the approver selects them per request | customer-facing account deletion, any claim of "erased" |
| **R7** Legal | Applicable law, jurisdictions, controller/processor roles, notices, processor contracts | Qualified review of: who is controller for customer data (merchant, Echo Grid, or joint), processor terms with Cloudflare, Neon, Resend, Twilio, Anthropic, Stripe, response deadlines, record-keeping duties, and what must be retained | No legal claim is made anywhere; the policy drafts are placeholders | publishing any notice or policy |
| **R8-A** Audit immutability | Approve database immutability of `audit_log` | **Approve** (merged as 0085) | Done at the database; the owner credential could still bypass it until R8-G is deployed | none (merged) |
| **R8-B** Historical audit metadata | May old audit rows be minimized | **No rewrite of audit rows.** The identity links are broken at the customer shell instead; keep audit rows immutable. Revisit only if a legal duty demands it | No exception to the audit guard exists | none |
| **R8-C** Forensic preservation | What evidence must stay | Audit rows, consent proof, sanctions, financial ledger, security events (`customer_auth_events`) pseudonymously, for periods set in R1 | Retained, pseudonymous | R1 |
| **R8-D** Redaction authority | Who may minimize audit data | No one (see R8-B). If ever needed: platform admin plus a second approver, through a dedicated audited function | None implemented | none |
| **R8-E** Identifiable retention | Which records must stay identifiable and how long | Keep the minimum identifiable data only for the approved purposes; staff identities in the audit log are retained per R3 | Staff/cashier identities remain in the audit log | R1/R3 |
| **R8-F** Audit API projections | Raw metadata vs filtered projections; whether billing sees raw data | Least privilege: privacy-filtered projections for business-facing audit; raw data for platform support/admin only where justified | No API contract was changed | API change |
| **R8-G** Non-owner runtime | Approve the runtime role design and the staged cutover | **Approve and stage**: provision and soak on staging, then production, then rotate the owner credential out of the Workers | Implemented and tested; **not provisioned or cut over** | deployment |

## Release and operations decisions

| ID | Decision | Notes |
|---|---|---|
| D1 | Client attribution secret configured on API, web and cashier Workers | open |
| D2 | Retention and erasure approval | the technical foundation is delivered; R1-R8 above are what remain |
| D3 | Cashier lockout pilot | open |
| D6 | Production release bundle | now **0080-0086, ledger 87** if both PRs merge; D6 was framed for 0080-0083 and must be re-ruled |
| P3 | Production migration | **not authorized**; needs a re-prepared plan, a valid snapshot and green exact-head CI |
| Backups | Retention/deletion of the recovery branch and snapshot; an out-of-band ledger of completed erasure references to re-apply after any restore | see section 9 of the D2-FINAL record; not executed |

## What blocks what

- **Nothing blocks merging the technical foundations** (both PRs are inert: no role is provisioned, no operator exists, no policy is enabled, no request exists).
- **Blocks real-customer processing:** R5 (nobody may run it), then R1/R2/R7 for any erasure, R6 for any customer-facing deletion claim, R4 for applying suppression.
- **Blocks production credential change:** R8-G approval plus a staged cutover authorization.
