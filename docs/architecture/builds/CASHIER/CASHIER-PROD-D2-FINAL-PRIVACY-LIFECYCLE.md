# CASHIER-PROD-D2-FINAL: customer privacy lifecycle, retention, erasure and audit linkage (2026-11-20)

Status: **TECHNICAL FOUNDATION IMPLEMENTED (migration 0086) AND TESTED ON DISPOSABLE POSTGRESQL. NOTHING IS ENABLED, NOTHING IS APPLIED TO ANY SHARED DATABASE, NO OPERATOR EXISTS.** Not legal advice and not a compliance claim. Baseline: `main` @ `5ecb618`. Stacked on R8-G (`security/r8g-nonowner-runtime`), because every new table must be classified in the runtime-role manifest. Migration number: **0086** (journal 87 entries). Owner decisions are in `CASHIER-PROD-D2-FINAL-OWNER-DECISIONS.md`; reviewable policy drafts are in `docs/privacy/DRAFT-POLICY-PACK.md`.

## 1. What is solved, and what is deliberately not

| Concern | Result |
|---|---|
| Path A: erased event -> `audit_log.entity_id` -> `metadata.membershipId` -> customer | **Closed for every new row** (forward minimization: `membershipId` no longer written); **closed for old rows too once the customer shell is anonymized** (the membership leads to an identity-free shell). No production onboarding rows exist yet (0083 not applied in production), so no production audit row ever had this shape. |
| Path B: exact `audit_log.created_at` -> membership `joined_at` -> customer | **Closed by customer shell anonymization**; it cannot be closed by editing the audit row (its time is the evidence). Tested. |
| Direct identifiers (phone, name, email, birthday, locale) | Irreversibly removed from the customer shell; the database refuses to let them be put back |
| Authentication, recovery, notification and OTP data | Deleted |
| Financial, consent, sanction and ledger records | **Retained, pseudonymous** (linked to the identity-free shell), never deleted by this process |
| Audit evidence | **Untouched and immutable** (0085 guard unchanged; nothing in 0086 modifies or redacts an audit row) |
| Who may run any of it | Nobody: the operator role has no members; no runtime access |
| Legal/retention decisions | **Open** (R1-R8). The retention registry ships disabled; no period is invented |

"Pseudonymous" is not "anonymous": the remaining behavioural and ledger history is kept for stated financial and security purposes and could in principle be re-linked by someone who already knows the person's activity. This is never described as anonymization.

## 2. Why anonymize a shell instead of deleting the customer

`customers` is referenced by 26 foreign keys: 15 cascade (sessions, credentials, memberships, loyalty accounts, consent grants...), 2 set null (auth events, referrer link) and 9 are RESTRICT (community point decisions and transactions, purchase events, orphan reward claims, settlement events and settlements, sanctions, survey participation, onboarding events). A hard delete is refused, or would cascade through the loyalty ledger (financial evidence). So the row stays, with its identifiers removed (`customers_anonymized_shape_check`), and `anonymized_at` set by the privacy owner role only. An anonymized customer can gain no membership, credential, session or onboarding event (triggers, serialized with the anonymization by a row lock), and issued QR tokens are invalidated (`qr_revocation_epoch`).

## 3. Personal-data inventory (verified from the schema and code unless marked)

Controller/processor roles are **subject to legal review (R7)**; "business" below means the merchant using Echo Grid.

| Store | Exists | Personal data | Purpose | Erasure treatment in 0086 | Notes / dependencies |
|---|---|---|---|---|---|
| `customers` | yes | phone, full name, email, birthday, locale | loyalty identity | **anonymized** (identifiers removed, row kept) | 26 FKs; unique verified phone index |
| `customer_credentials` | yes | login email, password hash | customer sign-in | deleted | |
| `customer_sessions`, `customer_refresh_tokens` | yes | device label, source hint, token hashes | sessions | deleted (tokens cascade) | |
| `customer_recovery_*`, `customer_auth_challenges`, `customer_action_authorizations` | yes | recovery digests, challenge digests | account recovery | deleted | |
| `customer_auth_events` | yes | event type, outcome, subject key, source hint, metadata | security trail | **retained** (customer_id -> shell) | contents not fully reviewed: NOT VERIFIED that no raw identifier appears; keep pending R8-C |
| `business_customer_memberships` | yes | customer link, join/leave times, onboarding reference | relationship | kept; `onboarding_reference` nulled | |
| `consent_grants` | yes | purpose/version, metadata | proof of consent | **retained** (consent evidence) | links to shell only |
| `customer_onboarding_events` | yes (0083/0084) | pseudonymous links, cashier, times | onboarding analytics | links severed (0084 function, called per business); times to UTC day | assisted events < 15 min deferred |
| loyalty accounts, transactions, purchase events, redemptions | yes | pseudonymous ledger | financial record | **retained** | RESTRICT/CASCADE structure forbids deletion |
| community memberships, point accounts, decisions, transactions | yes | pseudonymous | community points | retained | |
| survey participation | yes | pseudonymous | surveys | retained | |
| orphan reward/settlement tables | yes | pseudonymous | settlement | retained | financial |
| `customer_sanctions` | yes | action, free-text reason | fraud/safety | **retained** | reason is free text: review under R8-C; a hold may apply |
| `feedback` | yes | customer name/email/phone (typed by the customer), comment, device hash | business feedback | contact fields scrubbed **only if the approver chooses it**; comment kept | the comment is free text and may contain personal data: it cannot be reliably scrubbed (R6) |
| `notifications`, `notification_preferences` | yes | recipient address, body | messaging | deleted | |
| `conversations`, `messages` | yes | message bodies | customer-business messaging | deleted **only if chosen** | business may have a legitimate interest: policy (R6) |
| `otp_codes`, `otp_request_cooldowns` | yes | phone | verification | deleted by phone | |
| `audit_log` | yes | actor, entity ids, metadata, IP, user agent, exact time | security/forensic evidence | **retained, immutable (0085)**; forward minimized | IP/user agent appear on some rows: NOT VERIFIED which actions record customer IPs |
| `users` (staff, cashiers, platform) | yes | email/username, name | access control | **out of scope** (employee data) | R3 |
| `team_invitations` | yes | invitee email | staff invites | out of scope | |
| Stripe tables | yes | provider events (encrypted), business billing | billing | out of scope (business subscribers) | no customer card data found in the code searched |
| Application logs | yes (Workers observability enabled) | whatever is logged | operations | none | `Console*` dev providers log recipients but are dev-only; production log contents NOT VERIFIED; platform retention applies |
| Cache (KV `CACHE`) | yes | salted device/IP hashes (velocity tracker) | fraud velocity | none | TTL NOT VERIFIED |
| Queues (jobs) | yes | job payloads | async jobs | none | payload contents NOT VERIFIED; transient |
| Durable Object (password hasher) | yes | none persisted (hashing helper) | PBKDF2 offload | n/a | |
| Email (Resend), SMS (Twilio), AI summaries (Anthropic) | yes (processors) | recipient addresses, message bodies, feedback text | delivery, summaries | **no processor-side erasure is performed** | R7 and contracts; a separate vendor procedure is needed |
| Data exports | no export endpoint found in the code searched | | | | NOT VERIFIED beyond that search |
| Database backups, snapshots, branches | yes (Neon PITR, snapshot `snap-dawn-poetry-atr06u8j`, recovery branch) | **a full copy of personal data** | recovery | **erasure does NOT reach them** | see section 9 |

## 4. The design (smallest architecture that separates the four needs)

1. **Operational analytics** read `customer_onboarding_events`, whose links are severed on erasure and whose small groups can be suppressed (section 8).
2. **Personally identifiable relationships** live in `customers` (direct identifiers) and the erasable event/membership references. Removing the identifiers breaks every internal route to a person.
3. **Security and forensic evidence** (`audit_log`, `customer_auth_events`, sanctions, consent) stays immutable and pseudonymous.
4. **Retention-controlled linkage** is the shell id itself: pseudonymous, retained for the stated purposes, with legal holds and a registry that is disabled until approved.
No audit row is rewritten, so the 0085 guarantee is untouched and nothing here needs a guard exception on `audit_log`.

## 5. Privacy-request workflow (database-enforced; no public API)

States: `submitted -> identity_verification_required -> identity_verified -> scope_assessment -> retention_assessment -> approved -> processing -> completed | failed (retry)`; `rejected` is reachable from every state before `approved`. The map is enforced by a trigger, not only by the functions; `rejected` and `completed` are terminal; every transition is appended to `privacy_request_transitions` (identity of the DB session, platform actor, evidence reference).

Controls (all tested): only `customer_privacy_operator` can execute the functions; a platform user (support/admin, active) must act, **approval needs an active platform ADMIN who is not the verifier** (separation of duties); **replay protection** by unique request reference and unique verification proof; idempotent submit and processing; a customer-channel request requires the re-authentication method; free text is never stored (codes and reference patterns only). **No endpoint exposes this**: submission, verification and approval are operator steps until the Owner approves a workflow (R5). The database cannot itself prove a person's identity; it records who verified, how, and the evidence reference.

## 6. Customer anonymization behaviour

One transaction. Locks are taken in the **same order as join/leave/withdrawal** (relationship advisory locks sorted by business, then the request row, then the customer row), which avoids deadlock (a deterministic test proves the wait). Idempotent (a completed request is a no-op). An active **legal hold** is a recorded restriction: nothing changes and the request ends `failed` with `LEGAL_HOLD_ACTIVE`; it can be retried after release. Any failure rolls everything back (tested with an injected failure). Cashier attribution on events is kept unless the approver chooses to sever it (R3); feedback contact scrub and conversation deletion are separate approver choices. Financial records are never deleted.

## 7. Retention registry

Versioned `retention_policies` (one category today: onboarding events; trigger: age since occurrence), **disabled by default; enabling needs a period, an approving admin and an approval reference** (database check, not only code); content is immutable (register a new version); `retention_preview_onboarding_events(period)` is a **read-only dry run** that deletes nothing, works while every policy is disabled and records a run, so the Owner can see the effect of a candidate period before deciding; `retention_execute_onboarding_events(policy, batch)` runs only for an enabled policy, in bounded batches (1-500), skips pairs under a legal hold, isolates a failing pair, records the run, and is idempotent. There is no generic delete engine, no dynamic SQL and no other category. Execution does not run on a schedule: nothing schedules it.

## 8. Analytics privacy and cashier attribution

`applySmallGroupSuppression` (pure, 8 unit tests) and `summarizeWithPrivacy` fold groups below a **caller-supplied** threshold into one suppressed bucket with complementary suppression (so subtraction from the total cannot recover a hidden cell), show unique customers only above the threshold, hide small non-zero side counts, and can remove the per-cashier breakdown. **No threshold is applied anywhere by default and the analytics route is unchanged**: the number is the Owner's (R4). Distinct-customer counts for erased history are never estimated. Cashier identity is an indirect identifier: 0084 can sever it per request or per retention policy; the approver's choice is recorded. Cashier-account closure, session revocation and loyalty operations are unaffected (no cashier row is touched).

## 9. Backups, snapshots and the recovery branch (operational risk, not solved by code)

Erasure acts on the live database. The PITR window, snapshot `snap-dawn-poetry-atr06u8j` and the recovery branch contain the personal data as it was. Consequences and proposed controls (Owner to decide, R1/R7): delete the recovery branch and snapshot once no longer needed; keep an **out-of-band ledger of completed erasure request references** (not personal data) so that, after any restore, completed requests can be re-applied before the system serves traffic; restrict access to backups. No such control was executed here.

## 10. Operational authorization matrix (proposed; nothing assigned)

| Action | Who | Where enforced |
|---|---|---|
| Submit, assess, reject a request | platform support or admin acting through the privacy operator role | functions + role membership (empty today) |
| Verify identity | platform support or admin | function checks role; evidence reference unique |
| Approve | active platform admin, not the verifier | function and table guard |
| Process (anonymize) | privacy operator role | function; request must be `approved` |
| Place/release a legal hold | platform admin | function |
| Register/approve/disable a retention policy | register: operator; approve: platform admin with reference | function + database check |
| Business owner/admin/manager/staff/cashier | **no authority** | no grant; runtime role `NO_ACCESS` |
| Application runtime | none | R8-G manifest; privacy tables and functions unreachable (tested) |

## 11. Evidence and limits

Tests: `privacy-lifecycle.integration.test.ts` 29 (roles/ownership/EXECUTE; every table privilege held yet direct writes refused; superuser refused; state machine; actors; separation of duties; replay; anonymization with exact counts; options; retained records; cross-business; idempotence; no new activity; legal hold and retry; atomic rollback; **sweep over every text/jsonb column: the customer's phone and email appear nowhere**; concurrency including join, rejoin and hold races and a deterministic lock-order test; retention registry), 5 mutants caught; 8 unit tests; existing suites adjusted for forward minimization. **Not done / not verified:** concurrent deletion with live loyalty purchases (NOT RUN); production-shaped non-superuser rehearsal of 0086 beyond the full-chain apply (see report); contents of `customer_auth_events`, logs, queue payloads and cache TTLs; processor-side erasure; backups (section 9); any API or UI for requests; any scheduling of retention; legal review. **Release:** 0086 extends the pending bundle to **0080-0086 (ledger 87)**; D6 needs re-ruling; P3 is not advanced; this block ships no operator, no policy, no request and no credential.
