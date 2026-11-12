# ECHO GRID — CUSTOMER-AUTH-01C

## Existing-Customer Migration Plan: Password Enrollment After OTP, No Duplicates, Safe to Repeat, No Forced Invalidation

**Status: PROPOSED DESIGN — DOCUMENTATION ONLY. NOT LOCKED. NOT AN OWNER DECISION.**
Implementation, migration files, credential conversion, activation, rollout and deployment: **NOT AUTHORIZED**. Financial activation: NO-GO.

- Block: 01C of `CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md` (Part C). Authorized by the owner for design only.
- Depends on: 01A (`CUSTOMER_AUTH_01A_ARCHITECTURE_AND_SECURITY_ASSESSMENT.md`, merged in PR #381) and 01B (`CUSTOMER_AUTH_01B_DATA_CONTRACT.md`, PR #382, still a draft when this was written). This document is stacked on the 01B branch.
- Baseline: `main` at `f7008f9`.
- **VERIFIED** = read in source. **UNVERIFIED** = not checked. **PROPOSED** = Claude's recommendation, not a decision.
- CA-01 to CA-10 and the 01B decisions D-B1 to D-B9 remain open. This plan uses the recommended defaults, marks them, and adds its own decisions (MG-01 to MG-08, section 12). It answers none of them.
- **Nothing in this document was run.** No query was executed against any database, and no counts of customers are known.

---

## 1. Purpose and scope

**Purpose.** Describe how today's OTP-only customers gain a password and a revocable session without losing anything, without a duplicate identity, and without being forced out before a working recovery path exists (requirement 5, acceptance conditions 6 and 7).

**In scope.** Customer cohorts, the per-customer migration state model, the enrollment flows, idempotency and concurrency rules, the treatment of legacy 90-day tokens, a gap found in the 01B contract, progressive rollout, kill switches, rollback, edge cases, metrics, read-only pre-checks, the verification plan and decisions.

**Out of scope.** Migration files and SQL (01D), API and web code (01D, 01E), recovery option choice (CA-04), remote enrollment (01G), staff accounts, the customer QR, financial tables.

---

## 2. Current state relevant to migration (VERIFIED at baseline)

| Area                    | Fact                                                                                                                                                                                                                     | Evidence                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| How customers are born  | The **only** application code that creates a customer row is `completeVerifiedPhone`, after a verified OTP or a Twilio Verify approval. It sets `phone_verified_at` at creation. Other inserts are Gate 2 test fixtures. | `customer-auth.service.ts`, `customer.repository.ts`, `scripts/gate2-*` |
| Identity key            | `customers.phone` is `UNIQUE` across **all** rows, including soft-deleted ones. `findByPhone` excludes soft-deleted rows.                                                                                                | `db/schema/customers.ts`, `customer.repository.ts`                      |
| Create is not guarded   | `create` is a plain insert with no conflict handling. `completeVerifiedPhone` reads then creates.                                                                                                                        | `customer.repository.ts`, `customer-auth.service.ts`                    |
| What hangs off identity | Memberships (`customer_id`, unique per business), loyalty accounts (unique per customer and business), consent grants, transactions. All key on `customers.id`, never on the phone or a token.                           | `db/schema/*`                                                           |
| Session today           | One 90-day HS256 token with `sub`, `iat`, `exp` and no id. Verified per request against the customer row.                                                                                                                | 01A section 2                                                           |
| Web entry points        | The OTP login form and verify route set the `ff_customer_token` cookie. The loyalty QR path passes `autocheckin` and `next`.                                                                                             | `apps/web/src/app/loyalty/*`, `otp/verify/route.ts`                     |
| Customer QR             | Separate 5-minute signed token, unaffected by session changes.                                                                                                                                                           | `qr/customer-qr-token.ts`                                               |

**UNVERIFIED:** how many customers exist and in which state, how many hold a still-valid token, whether any customer has `phone_verified_at` null, whether any soft-deleted customers exist, and the live state of `0067` and every other migration.

---

## 3. Migration principles

1. **Lazy, per customer, on the customer's own action.** There is no bulk job that touches existing customer rows. The 01B tables start empty and fill only as customers enroll.
2. **Identity never changes.** Nothing in this plan creates, merges, splits or renames a `customers` row. A password attaches to the existing `customers.id`.
3. **A fresh phone proof before any credential.** A password can be set only right after a fresh OTP proof (or a recent step-up inside a new-model session). A legacy token alone is not enough (section 6).
4. **No forced logout of customers who did nothing.** A customer who never enrolls keeps working exactly as today until their own token expires, then signs in with an OTP as they do now.
5. **The OTP path always works.** A customer with no password can always sign in by code. A customer with a password can always fall back to a code. This is the "compatible recovery path" requirement 5 asks for, and it exists **before** any password does.
6. **Idempotent and repeatable.** Every step can run twice and leave the same end state.
7. **No unauthorized business effect.** Enrollment grants no points, no membership, no consent, no marketing opt-in, and touches no financial table.

---

## 4. Customer cohorts

| ID  | Cohort                                            | Today                                | Migration treatment (PROPOSED)                                                            |
| --- | ------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| C0  | Active, phone verified, holds a still-valid token | Works with the 90-day token          | Keeps working. Offered a password at the next natural fresh OTP, or on request            |
| C1  | Active, phone verified, no valid token            | Must sign in by OTP                  | Signs in by OTP as today. **Offered a password in that same flow**, at no extra SMS       |
| C2  | Suspended                                         | Cannot sign in                       | No change. Suspension also blocks enrollment. Sessions are revoked on suspension (01B I7) |
| C3  | Soft-deleted                                      | Cannot sign in, phone still occupied | No change. See edge case E4 (the phone is still reserved by the unique constraint)        |
| C4  | `phone_verified_at` is null                       | Should not exist by code             | UNVERIFIED. Treated like C1. The OTP verify already marks the phone verified              |
| C5  | New customers after release                       | Created at first OTP                 | Registration flow requires a password (CA-03 default) once the new model is on            |

Cohort sizes are **unknown** until the read-only checks in section 11 are authorized and run.

---

## 5. Per-customer migration state

```
S0  LEGACY            customer row, no credential, may hold a legacy token
S1  VERIFIED_SESSION  fresh OTP proof, new-model session, no password yet
S2  ENROLLED          credential row present, new-model session(s)
```

```
S0 ──fresh OTP──► S1 ──set password──► S2
S0 ──(never acts)──► S0   (valid forever, until own token expires, then OTP)
S1 ──(skip)────────► S1   (works, prompted again later)
S2 ──forgot──► OTP + new password ──► S2   (other sessions revoked)
```

- S0 and S1 are **supported end states**. A customer is never required to reach S2 (CA-03 default: offered at first return, required only for **new** registrations, MG-01).
- State is derived, not stored in a new column: S2 means a `customer_credentials` row exists. S1 means a live new-model session without one. No flag is added to `customers` (01B constraint 3).

---

## 6. Enrollment flows (PROPOSED)

### 6.1 Flow A: password offered during a natural OTP sign-in (cohorts C0 and C1)

```
Customer ─► enters phone ─► receives code ─► enters code
          ─► server: verified phone ─► find-or-create customer (existing row) ─► new-model session (auth_method = otp)
          ─► offer: "Create a password so you can sign in faster next time"  [Create] [Not now]
          ─► [Create]: choose password ─► server checks step-up is fresh ─► writes credential ─► revokes legacy tokens older than now (section 7) ─► done
```

- No extra SMS: the proof is the sign-in the customer was already doing.
- The offer is skippable. Choosing "Not now" keeps S1 and changes nothing else.
- The password rules, hashing and storage follow 01A section 6.2 and 01B section 5.1.

### 6.2 Flow B: customer holds a legacy token and wants a password now (cohort C0)

A legacy token carries no session and no step-up proof, so it is **low assurance** (01A section 6.8). Setting a password from it alone is **not allowed**. The customer must complete one fresh OTP first, then Flow A continues. Cost: one SMS, only for customers who choose to enroll before their token expires.

**Why this matters.** If a stolen legacy token could set a password, an attacker could pin a credential on the victim's account and keep access even after the victim reacts. Requiring a fresh phone proof stops that.

### 6.3 Flow C: returning customer with a password

Phone and password sign in, no SMS. The login form always shows "Use a code instead", so a customer without a password, or who forgot it, is never dead-ended. Responses never reveal whether the phone has a password (01A section 6.3). A customer with no credential who types a password receives the same generic failure as an unknown phone, and the code option is visible either way.

### 6.4 Flow D: forgot password

Phone, then OTP (option R1, CA-04 pending), then a new password. All other sessions are revoked and legacy tokens older than now are rejected (01B I6, section 7 below). Because OTP is always available, **no customer can be locked out by this migration**.

---

## 7. Legacy 90-day tokens

Today's tokens cannot be revoked individually because they have no id (01A finding A1). The plan treats them as follows.

| Situation                                      | Behavior (PROPOSED)                                                                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer never enrolls                         | Legacy token accepted until its own `exp`. No forced invalidation                                                                                                                               |
| Customer enrolls (sets a password) or recovers | Legacy tokens for that customer with `iat` earlier than the enrollment moment are **rejected from then on**. The customer already holds a new-model session                                     |
| New logins after the new model is on           | Issue **new-model** sessions only. No new legacy token is issued once a customer is inside the rollout cohort                                                                                   |
| Normal use of a legacy token                   | Low assurance: ordinary loyalty use works. Credential changes, step-up actions and device management need a fresh OTP                                                                           |
| Abuse suspected                                | A global kill switch can stop accepting **all** legacy tokens (section 9). This forces every legacy holder to sign in by OTP, which costs SMS, so it is a deliberate last resort                |
| End of life                                    | Legacy issuance stops at the start of rollout. The longest tail is 90 days after the last legacy token was issued. Removing the legacy verifier is a later, separately authorized block (MG-06) |

### 7.1 Gap found in the 01B data contract

01B does not provide a way to reject a customer's older legacy tokens once they enroll. Without it, a stolen legacy token would survive the victim setting a password and would defeat the point of enrolling. This plan therefore requires an **amendment to 01B**:

> **01B-AMEND-1 (PROPOSED).** Add one nullable timestamp, `legacy_tokens_invalid_before`, to `customer_credentials`. It is set to the current time whenever a credential is created or changed, on recovery and on "log out everywhere". A legacy token is accepted only if its `iat` is **not earlier** than that value (or the value is null). Customers without a credential row are unaffected.

- It stays inside the new table, so **`customers` is still untouched** and the contract remains additive.
- Cost: the legacy path needs the credential row at verification. That is one left join added to the same query that already reads the customer (01B section 10), and it is needed only for legacy tokens.
- 01B is not edited by this block. The amendment needs the owner's go-ahead (MG-02) and a change to the draft PR #382.

---

## 8. Idempotency, concurrency and no-duplicate rules

| Case                                                           | Rule (PROPOSED)                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enrollment submitted twice (double click, retry)               | Credential primary key is `customer_id`. The second write finds the row. If the request is the same enrollment event it returns success without a second hash write. A genuine later "change" requires the current password or a fresh step-up                        |
| Two devices enroll at the same moment                          | One insert wins. The other receives "already set" and is moved to sign-in. Neither creates a customer row. Both end with a valid session                                                                                                                              |
| Two first-time OTP verifications of the same new phone at once | **Pre-existing hazard** (section 2): find-then-create with a unique phone can make the second insert fail. 01D should make create a conflict-safe upsert and re-read. No duplicate row is possible because `phone` is unique, but the loser must not receive an error |
| Password set but session creation fails                        | The credential is valid. The customer signs in by password or code. Nothing needs cleanup                                                                                                                                                                             |
| Session created but password step abandoned                    | State S1. Stays valid. Prompted again later (MG-03)                                                                                                                                                                                                                   |
| Re-running the whole migration                                 | There is no batch step to re-run. Each customer's transition happens on their own action and is repeatable                                                                                                                                                            |
| Any path creating a second customer for the same phone         | Not permitted. Registration after OTP always resolves to the existing row by phone                                                                                                                                                                                    |

**Preservation checks (what must not change).** For any customer, before and after enrollment: `customers.id`, `phone`, memberships, loyalty accounts, points and reward balances, consent grants, feedback and survey history, QR eligibility and Community membership are identical. Only new rows appear in the four 01B tables.

---

## 9. Progressive rollout and kill switches (CA-09 inputs)

| Phase | Name                 | What is on                                                                                               | Exit criteria (PROPOSED)                                                                         |
| ----- | -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| P0    | Prerequisites        | `0067` applied and verified. Migration order decided (D-B9). 01B tables created empty, feature **off**   | No behavior change. Gate 2 re-pinned and passing in the target environment                       |
| P1    | Dark launch          | New-model sessions and password enrollment for an **allow-list** of internal test customers only         | Real-device and Twilio Verify tests pass (CA-10). No replay or enumeration findings              |
| P2    | Cohort rollout       | A small percentage, chosen by a stable hash of `customers.id` so a customer stays in or out consistently | Error and OTP volume within bounds for an agreed period. Enrollment completes. No duplicate rows |
| P3    | General availability | All customers. Legacy tokens still accepted until natural expiry                                         | Legacy usage trending to zero                                                                    |
| P4    | Legacy sunset        | Legacy verifier removed in a separate authorized block                                                   | No `legacy_token_used` events for a full 90 days                                                 |

**Kill switches (PROPOSED).** Two, with different effects.

- **KS-1, `new_model_enabled`.** Turn the new model off for new logins. New sign-ins fall back to issuing legacy tokens. Sessions already issued under the new model **must keep verifying**, so the new verifier stays deployed once released. This is the normal rollback.
- **KS-2, `legacy_tokens_accepted`.** Reject all legacy tokens. Last resort only, because it forces every legacy holder through an OTP and spikes SMS cost.

How the switches are stored and who can flip them is decision MG-05. Whether a switch can be flipped **without a code deployment** on the current Workers setup is **UNVERIFIED** and must be confirmed in 01D.

---

## 10. Rollback and recovery posture

| Situation                                             | Action                                                                                                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New model misbehaves in P2                            | Flip KS-1. Customers with new-model sessions keep working. No customer data is lost                                                                                      |
| Defect in enrollment                                  | Disable the offer. Customers fall back to OTP. Existing credentials stay and still work for sign-in                                                                      |
| Need to remove the feature entirely after data exists | Prefer to **stop using** the tables and keep them, as 01B section 11.4 and the repository's `0067` guidance say. Dropping would delete customers' passwords and sessions |
| Suspected stolen-token abuse                          | Per-customer: enroll or recover, which invalidates older legacy tokens. Global: KS-2, with the SMS cost accepted in advance (MG-07)                                      |
| Database problem                                      | Restore path depends on a backup route that the BDPN plan records as **not yet confirmed**. This must be confirmed before any production migration                       |

Because the 01B tables are additive and start empty, and no existing table or row is modified, the **blast radius of the migration itself is the new tables only**.

---

## 11. Read-only pre-checks (NOT RUN, need your authorization)

These would size and de-risk the rollout. Each is a count or an existence check. None changes data. **None has been run.**

```sql
-- cohort sizes
SELECT status, is_deleted, (phone_verified_at IS NULL) AS unverified, count(*)
FROM customers GROUP BY 1,2,3;

-- anything unexpected about phone formats or duplicates
SELECT count(*) FROM customers WHERE phone !~ '^\+[1-9][0-9]{6,14}$';

-- scale of what hangs off identity (context for the preservation checks)
SELECT count(*) FROM business_customer_memberships;
SELECT count(*) FROM loyalty_accounts;
```

Also needed, and **not SQL**: the live migration state of every environment, the backup and restore path, the Twilio Verify settings, and whether a config flag can be changed without a deployment. The owner must authorize any live inspection. A disposable database would not give real cohort sizes.

---

## 12. Edge cases

| ID  | Case                                                        | Treatment (PROPOSED)                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Customer suspended mid-flow                                 | Enrollment and sign-in fail, sessions revoked (01B I7)                                                                                                                                                                                                            |
| E2  | Customer with a legacy token on two devices, enrolls on one | Other device's legacy token is rejected afterwards. That device shows the login page and the customer signs in by password or code                                                                                                                                |
| E3  | Customer abandons enrollment                                | Stays in S1. Prompted again at most N times in a period (MG-03), tracked client-side or by event, with no new column                                                                                                                                              |
| E4  | Soft-deleted customer's phone                               | By code reading, a new registration for that phone would hit the unique constraint, because `findByPhone` ignores deleted rows while the constraint does not. Not reproduced. Whether any customers are deleted is UNVERIFIED. Decision needed if deletion exists |
| E5  | Phone number recycled to a different person                 | The new holder can sign in by OTP and reach the previous holder's account. A password does not prevent this while SMS recovery exists. Pre-existing risk (01A T2). Accepting it, or adding step-up for high-risk actions, is MG-08                                |
| E6  | Customer forgets password and loses the phone               | Outside OTP. Depends on CA-04 (email, support-assisted). Until decided, such a customer relies on their number                                                                                                                                                    |
| E7  | Business QR scan with `autocheckin` during migration        | Unchanged for legacy holders. For new-model sessions the flow reads the session. The 5-minute customer QR is independent                                                                                                                                          |
| E8  | Customer typed a password but has none                      | Same generic failure as an unknown phone, with the code option shown                                                                                                                                                                                              |
| E9  | Rollout cohort changes for a customer                       | Cohort is a stable hash of the customer id, so membership does not flap. Moving a customer out simply issues legacy tokens again                                                                                                                                  |
| E10 | OTP SMS cost during enrollment                              | Flow A adds none. Flow B adds one SMS per enrolling legacy holder. Totals depend on cohort sizes, which are unknown                                                                                                                                               |

---

## 13. Metrics and monitoring (PROPOSED)

Share of customers in S0, S1 and S2. OTP requests per day and estimated SMS cost. Password login success and failure rates. Enrollment starts, completions and abandonments. `legacy_token_used` per day (the tail). Replay and rate-limit events. Duplicate-phone errors (should be zero). Support contacts about login. These use the 01B event vocabulary and need no new tables.

---

## 14. Verification the implementation must provide (not performed here)

- **No-duplicate proof.** Run enrollment on fixtures twice and concurrently. Row counts in `customers` by phone stay at one.
- **Preservation proof.** Snapshot memberships, loyalty accounts, balances, consent and history before and after enrollment. They are identical.
- **Legacy tests.** Valid before the cutoff, rejected after a password set, a recovery and a logout-everywhere. Rejected under KS-2 and accepted when KS-2 is off.
- **Assurance tests.** A legacy token **cannot** set or change a password. A fresh OTP can.
- **Enumeration tests.** A customer without a password and an unknown phone return identical responses.
- **Concurrency tests.** Two devices enrolling, double submits, and two first-time OTP verifications of one new phone.
- **Rollout tests.** Cohort stability, KS-1 and KS-2 behavior, rollback to legacy issuance.
- **Disposable replay.** A clean PostgreSQL 18 replay of the full journal with seeded legacy-state fixtures, plus the Gate 2 re-run.
- **Real-device and Twilio Verify test** before activation (CA-10, needs your credential and budget decision).

---

## 15. Decisions needed

| ID    | Question                                                                                     | Default used here (PROPOSED)                                        | Needed before |
| ----- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------- |
| MG-01 | Is a password offered or required for existing customers, and for new ones                   | Offered for existing, required for new registrations (CA-03)        | 01D           |
| MG-02 | Approve 01B-AMEND-1, `legacy_tokens_invalid_before` on the credential row                    | Yes                                                                 | 01D           |
| MG-03 | How often to re-offer the password after "Not now", and where that is tracked                | A small number of offers per period, tracked client-side            | 01E           |
| MG-04 | Rollout mechanism and percentages for P2                                                     | Stable hash of the customer id, small start. Numbers need the owner | P2            |
| MG-05 | Where the kill switches live, who may flip them, and whether a flip needs a deployment       | To be confirmed in 01D                                              | P1            |
| MG-06 | Legacy sunset date and who authorizes removing the legacy verifier                           | 90 days after the last legacy issuance                              | P4            |
| MG-07 | SMS budget for Flow B enrollment and a pre-approved ceiling for an emergency KS-2            | Owner must set                                                      | P1            |
| MG-08 | Accept the recycled-number risk for now, or require extra verification for high-risk actions | Accept for migration, handle through step-up in 01D                 | 01D           |
| MG-09 | Authorize the read-only pre-checks in section 11 and the live migration-state inspection     | Not authorized                                                      | P0            |
| MG-10 | How to treat soft-deleted customers' phones if deletion is in use (E4)                       | Confirm whether deletion exists first                               | 01D           |

Inherited and still open: CA-01, CA-02, CA-04, CA-08, CA-09, CA-10 and D-B1 to D-B9 (D-B9 is the migration order against `0067` and BDPN).

---

## 16. Risks, assumptions, residual risk

- **No live data was read.** Cohort sizes, deleted-customer counts and verified-phone gaps are unknown. The plan is shaped to need none of them, but the rollout numbers do.
- **01B is incomplete without 01B-AMEND-1.** Until it is approved and the 01B draft updated, the legacy-token gap in section 7.1 stays open.
- **Recovery without the phone** (E6) is undefined until CA-04 is decided.
- **Phone recycling** (E5) is reduced by step-up, not removed.
- **The pre-existing create race** (section 8) and the **soft-deleted phone case** (E4) come from reading the code, not from running it.
- **SMS cost** of enrollment and of an emergency legacy kill is unquantified.
- **Gate 2 and migration ordering** (0067, BDPN, this) are 01B and D-B9 concerns and still apply.

## 17. Future work

01D API and migration (including the conflict-safe customer create and the legacy-cutoff check), 01E web enrollment UI, 01F business-QR path, 01G remote enrollment (needs a D-18 amendment), 01H certification and progressive rollout. Each needs its own authorization.

## 18. Changelog

| Date       | Change                            |
| ---------- | --------------------------------- |
| 2026-11-12 | First draft of 01C (design only). |
