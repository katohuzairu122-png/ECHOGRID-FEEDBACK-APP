# Echo Grid privacy policy pack: DRAFTS FOR OWNER AND LEGAL REVIEW

**DRAFT. NOT LEGAL ADVICE. NOT APPROVED. NOT TO BE PUBLISHED.** Text in `[OWNER DECISION]` brackets is deliberately blank: no retention period, legal basis, jurisdiction or deadline is asserted. Drafted from the actual system (see `docs/architecture/builds/CASHIER/CASHIER-PROD-D2-FINAL-PRIVACY-LIFECYCLE.md`). The technical capabilities described exist in the repository but are **not enabled** in any shared environment.

## 1. Privacy notice (outline)
- **Who we are and roles:** Echo Grid (platform) and the participating business. Which of us is the controller or processor of customer loyalty data is `[OWNER DECISION: R7, qualified review]`.
- **What we collect from customers:** phone number (verified by one-time code), optional name, email and birthday, loyalty activity (visits, points, rewards, redemptions), consent records, feedback a customer chooses to submit (which may include contact details), messages with a business, device/session information for sign-in security.
- **Why:** to run the loyalty programme, verify the customer, prevent fraud, give the business visit and loyalty analytics, and keep security and financial records. `[OWNER DECISION: lawful basis per purpose]`.
- **Who receives it:** the business the customer joined; service providers for hosting (Cloudflare, Neon), email (Resend), SMS (Twilio), AI summaries of feedback (Anthropic), billing for businesses (Stripe). `[OWNER DECISION: confirm list and contracts]`.
- **How long:** `[OWNER DECISION: R1 per purpose]`.
- **Rights and how to use them:** request erasure through `[OWNER DECISION: channel]`; identity is verified before anything is changed (section 3). Some records must be kept (financial, consent proof, security) and are then kept without direct identifiers where possible.
- **Complaints / contact:** `[OWNER DECISION]`.

## 2. Data-retention policy (framework, no durations)
Purpose-based table with columns: category, purpose, legal basis, retention criterion or period, trigger, exceptions (legal hold), erasure method. Categories: customer identity, authentication data, onboarding events, loyalty/financial ledger, consent proof, sanctions, feedback, messages, audit and security evidence, cashier/staff identity, backups. **Every period is `[OWNER DECISION: R1]`.** Until a period is approved, the retention registry stays disabled and nothing is deleted automatically. Indefinite retention is not a safe default and must be closed.

## 3. Customer data-erasure procedure (operator runbook; not yet executable)
1. **Receive** the request through the approved channel and record a request reference. `[R5]`
2. **Submit** (`submitted`). 3. **Verify identity** (`identity_verification_required` -> `identity_verified`): either the customer re-authenticates in the app, or an operator completes an out-of-band check defined by the Owner; record the method and a one-time evidence reference (a proof can be used once).
4. **Scope assessment** and **retention assessment**: check for legal holds, unsettled balances or pending rewards, open disputes and sanctions; decide the optional steps (contact scrub in feedback, message deletion, cashier severance) with a written reason code.
5. **Approve** by a **different** platform administrator than the verifier. 6. **Process**: the system removes direct identifiers, deletes sign-in/recovery/notification/OTP data, severs onboarding links, and keeps ledgers, consent and sanctions without identifiers. 7. **Confirm** to the customer what was done and what was kept and why. 8. **Record** completion; re-apply after any database restore (the request reference ledger). A legal hold stops processing and is recorded; it is not an erasure.

## 4. Consent and withdrawal handling
Consent to join a business's loyalty programme is recorded per business with a version; withdrawal and leaving are recorded as state changes and take the same relationship lock as joining. Withdrawal of consent does not by itself erase data; erasure is a separate verified request. `[OWNER DECISION: effect of withdrawal on retention]`.

## 5. Customer-account deletion
Implemented as **anonymization of the customer record** (identifiers removed, ledgers kept under an identity-free key), not row deletion, because financial and security records must be preserved. Customers must not be told their data was "deleted" unless the specific items are listed. `[OWNER DECISION: R6 per item]`.

## 6. Audit-evidence retention
Audit rows are immutable at the database and are not rewritten for privacy; direct identifiers are removed from the customer record instead, so audit rows no longer lead to a person. Period `[OWNER DECISION: R1/R8-C]`. Staff identities appear in the audit log `[OWNER DECISION: R3]`.

## 7. Processor and subprocessor responsibilities (to be confirmed)
Cloudflare (Workers, KV cache, queues, logs), Neon (database, backups), Resend (email), Twilio (SMS), Anthropic (feedback summaries), Stripe (business billing). For each: data categories, location, contract/DPA status, deletion on request, breach notice time. `[OWNER DECISION + legal: R7]`. **Processor-side erasure is not performed by this system.**

## 8. Privacy-request verification
Two-person control (verifier, approver) by platform staff; a unique verification proof per request; no verification by unauthenticated email alone `[OWNER DECISION: acceptable evidence]`.

## 9. Incident escalation
Suspected unauthorized use of the privacy operator role, an audit-guard bypass, or a restored backup containing erased data: stop processing, preserve evidence, notify the Owner and legal contact, assess notification duties `[R7]`, record the incident. The runtime role cannot disable audit protections (R8-G, once cut over).

## 10. Backup and snapshot considerations
Backups, point-in-time history, the verified snapshot and the recovery branch hold personal data as it was. Decide how long each is kept, who can restore, and how completed erasures are re-applied after a restore (keep a minimal ledger of completed request references outside the database). `[OWNER DECISION: R1/R7]`.

## 11. Operational authorization matrix
See section 10 of the D2-FINAL record: platform support/admin act through a dedicated operator role; business roles and the application runtime have no authority.

## 12. Compliance verification checklist (what must be true before any real-customer processing)
- [ ] R1-R8 decided and recorded. [ ] Legal review of notice, roles and processor contracts done.
- [ ] Operator role assigned to named people, on a login separate from the runtime and migrator; the assignment is recorded.
- [ ] R8-G cutover done on staging then production; verification SQL returns no rows.
- [ ] Verification evidence method agreed and tested end to end on staging.
- [ ] Backup handling and the restore re-apply procedure agreed.
- [ ] A dry run (`retention_preview_*`) reviewed by the Owner for every period approved.
- [ ] Customer-facing wording reviewed so nothing claims more than is done.
