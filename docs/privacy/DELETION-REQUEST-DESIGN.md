# Delete my account data: customer request with a 30-day restore window; business closure request (design, 2026-11-24)

Status: **DESIGN FOR OWNER REVIEW. NOTHING IMPLEMENTED, MIGRATED OR DEPLOYED.** Not legal advice; the wording shown to people needs the R7 review.

## 1. Decisions taken by the Owner (2026-11-24)
1. **Customers:** a "Delete my account data" **request** button; a platform privacy operator processes it (the D2-FINAL engine: shell anonymization, legal holds, append-only audit). **The account stays restorable for 30 days.** No instant self-service erasure.
2. **Businesses:** a separate later block. For now an owner can only **request closure**; nothing is deleted.

## 2. Constraint that shapes the design
The D2-FINAL privacy tables and functions are **not reachable by the application runtime** (no table privilege, no EXECUTE; enforced by CI gates and the runtime-role manifest). The button must not weaken that. So the app writes only to a **new, app-owned request table**; the privacy operator reads it and drives the existing engine. The runtime role still gets no access to `privacy_*` objects.

## 3. Customer flow
```
Settings > "Delete my account data" > explanation (what is removed, what is kept, 30 days) > password re-entry (fresh step-up) > confirm
   -> request row (pending, scheduled_for = now + 30 days) + all sessions revoked + audit event + confirmation email (if an email is on file)
   -> next sign-in: a single "Your account is scheduled for deletion on <date>" screen with [Restore my account] and [Sign out]
   -> Restore (any time before scheduled_for): request cancelled, account fully usable again, audit event
   -> after scheduled_for with no restore: the request becomes ELIGIBLE (a read-only view for the operator). Nothing is erased automatically.
   -> operator (verification evidence = the customer's own re-authentication when the request was filed) runs the existing request workflow:
      submit > verify > approve (second admin) > anonymize. Legal holds still stop it.
```
Until restored or processed, a pending account can use **nothing** except the restore screen and sign-out; loyalty data is untouched (so restore is lossless).

## 4. What is removed and what is kept (existing D2-FINAL behaviour, unchanged)
Removed: phone, name, email, birthday, locale, sign-in credentials and sessions, recovery data, notifications and preferences, one-time codes, onboarding-event links (times to the day). Kept, pseudonymous and with no identifier: membership rows, consent grants, loyalty and community ledgers, sanctions, anonymous feedback text (contact fields only if the approver chooses). Backups, processors and the audit history are not reached (R7). The screen must say so plainly.

## 5. Proposed data model (migration 0087, additive)
`customer_deletion_requests(id, customer_id FK RESTRICT, status pending|cancelled|eligible_processed, requested_at, scheduled_for, cancelled_at, reauth_evidence_ref, processed_privacy_request_id NULL)`; partial unique index: one **pending** row per customer; CHECK `scheduled_for = requested_at + 30 days` and status/timestamp shape. Runtime verbs: SELECT, INSERT, UPDATE (cancel only; a guard trigger refuses any other change). No DELETE, no TRUNCATE. Added to the runtime manifest (the coverage test forces it). It holds no personal data beyond the pseudonymous customer id.

## 6. API (customer, behind the existing customer authentication)
- `POST /customer-account/deletion` (needs a fresh step-up, rate limited): files the request, revokes sessions, writes audit, queues the email. Idempotent while pending.
- `GET /customer-account/deletion`: status and date (allowed while pending).
- `POST /customer-account/deletion/restore`: cancels (allowed while pending; refused after processing).
- **Pending enforcement in the one shared customer authentication middleware:** while a pending row exists every customer route answers `403 ACCOUNT_DELETION_PENDING` with the date, except the three routes above, sign-out and session refresh. One indexed lookup per request.

## 6a. Web
Settings section with the explanation and re-entry form; the pending screen with Restore; copy in en, es, fr, ar; the chooser and sign-in pages unchanged.

## 7. Business closure request (separate, later block)
Owner-only (business-wide) "Request account closure": records a `business_closure_requests` row, an audit event and an ops alert to platform admins; **deletes nothing and does not change the business's operation**. Real business erasure waits for R1/R7 (financial, Stripe, settlement and audit retention) and a decision on customers' ledgers owed.

## 8. Risks and how the design answers them
| Risk | Answer |
|---|---|
| Account takeover requests deletion | Fresh step-up required; 30-day restore; confirmation email; operator verification before anything is erased |
| Customer loses data by mistake | Nothing is erased for 30 days and never automatically; restore is lossless |
| Pending account keeps earning | Hard 403 in the shared middleware |
| Runtime reaches the privacy engine | It does not: the new table is the only thing the app touches |
| No operator exists (R5) | Requests queue as eligible; **the button is honest about timing**; processing needs R5 |
| Legal expectations (deadlines, notices) | R7 review of the wording and of the 30-day period before release |

## 9. Roadmap (one gated block at a time)
1. **CUST-DEL-01 backend:** migration 0087, repository, the three routes, shared-middleware enforcement, audit, tests (real PostgreSQL, also as the restricted runtime login), manifest update. Draft PR; staging migration is a separate authorization.
2. **CUST-DEL-02 web:** settings section, pending screen, four languages, tests.
3. **CUST-DEL-03 operator view and runbook:** eligible-requests query, procedure to submit and process through the existing engine (needs R5).
4. **BIZ-CLOSE-01:** business closure request (section 7).
Release: staging first for each; production only with your separate authorization; migration 0087 is a new production gate (P3-style).

## 10. Open items for the Owner
R5 (who is the operator), R7 (legal review of wording and the 30-day period), whether to email the customer a reminder before day 30, and whether processing should later be automated after the period.
