# ECHO GRID — CUSTOMER-AUTH-01B

## Customer Authentication Data Contract: Credentials, Sessions, Audit Events, Migration and Gate 2 Impact

**Status: PROPOSED DESIGN — DOCUMENTATION ONLY. NOT LOCKED. NOT AN OWNER DECISION.**
Implementation, migration files, schema changes, credential conversion, activation and deployment: **NOT AUTHORIZED**. Financial activation: NO-GO.

- Block: 01B of `CUSTOMER_AUTH_01_REQUIREMENTS_AND_ROADMAP.md` (Part C). Authorized by the owner for design only.
- Depends on: `CUSTOMER_AUTH_01A_ARCHITECTURE_AND_SECURITY_ASSESSMENT.md` (PR #381, still a draft when this was written). This document is stacked on that branch and uses its section numbers (T = threat, A = finding).
- Repository baseline: `main` at `9bf2b45`. 01A baseline: `8c9d0dc`.
- **VERIFIED** = read in source or migrations. **UNVERIFIED** = not checked. **PROPOSED** = Claude's recommendation, not a decision.
- Owner decisions CA-01 to CA-10 are still open. Where this contract depends on one, it uses the 01A recommended default, marks it, and lists the dependency in section 12. Nothing here answers them.
- This is a **contract**, not DDL. Column lists describe what must be storable. Exact types, constraint names and the migration file are 01D work.

---

## 1. Purpose and scope

**Purpose.** Define what the database must be able to store and guarantee so that the 01A session model, password login, recovery and audit trail can be built safely, and state the migration and Gate 2 consequences.

**In scope.** New entities, their relationships, invariants, state machines, indexes and access patterns, retention and privacy rules, what is deliberately **not** stored, the migration list, Gate 2 and sequencing impact, and the repository operations 01D must provide.

**Out of scope.** SQL, Drizzle code, API and web behavior, the existing-customer migration procedure (01C), remote enrollment (01G), staff authentication, the customer QR token, Split 05 to 08 financial tables.

---

## 2. Current data state (VERIFIED at baseline)

| Item                            | Fact                                                                                                                                                                                                                                                                 | Evidence                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `customers`                     | One row per phone (`phone` unique, E.164). Columns include `full_name`, `email` (unverified, no uniqueness), `birthday`, `phone_verified_at`, `preferred_locale`, `status` (`active` or `suspended`), audit columns, soft delete. **No credential column.**          | `apps/api/src/db/schema/customers.ts`                                                    |
| `otp_codes`                     | Ephemeral OTP hashes with attempts and expiry. No FK to `customers`. Used by the local OTP path only.                                                                                                                                                                | `db/schema/otp-codes.ts`                                                                 |
| `otp_request_cooldowns`         | One reservation row per phone for request serialization.                                                                                                                                                                                                             | `db/schema/otp-request-cooldowns.ts`                                                     |
| `refresh_tokens` (staff)        | Hashed token per row, `session_id`, `revoked_at`, `replaced_by_token_id` as a trail marker with **no** FK, `user_agent`, raw `ip_address`. Non-unique index on `(user_id)` and `(user_id, session_id)`.                                                              | `db/schema/refresh-tokens.ts`                                                            |
| `password_reset_tokens` (staff) | Hashed 256-bit token, plain SHA-256 by design because the token is high-entropy. `consumed_at` and `invalidated_at` kept distinct.                                                                                                                                   | `db/schema/password-reset-tokens.ts`                                                     |
| `audit_log`                     | Append-only, but its actor column is an FK to staff `users` and it is business-oriented (`business_id`). It has **no customer actor column**.                                                                                                                        | `db/schema/audit-log.ts`                                                                 |
| `consent_grants`                | Per customer and business, purpose-specific, versioned, with status and idempotency key. Not for account-level notices today.                                                                                                                                        | `db/schema/consent-grants.ts`                                                            |
| Shared columns                  | `auditColumns` (created/updated by and at) and `softDeleteColumns`, deliberately **not** spread on short-lived security artifacts.                                                                                                                                   | `db/schema/_shared.ts`, comments in the two schemas above                                |
| Migrations                      | Journal ends at `0067_customer_preferred_locale` (68 entries). `0067` is **pending in production and staging** per the roadmap's 2026-11-12 read-only check.                                                                                                         | `apps/api/drizzle/`, roadmap Part D                                                      |
| Gate 2 pinning                  | Several Gate 2 scripts assert exactly 68 applied migrations. The BDPN plan records that a migration PR must re-pin in the same PR and counts 22 matching files for a broad search.                                                                                   | `apps/api/scripts/gate2-b*.mjs`, `BDPN_MIGRATION_PLAN_AND_STATE_CORRECTION.md` section 6 |
| Gate 2 table checks             | The restricted-login script checks that **no** public table has select, insert, update, delete or truncate for the restricted login, and that direct reads of `customers`, `refresh_tokens` and others are denied. The total-table check is a lower bound (`>= 90`). | `apps/api/scripts/gate2-b1-restricted-broker-denial.mjs`                                 |
| Runtime login                   | Recorded as the owner role with row-level-security bypass. A pre-existing Gate 2 finding, not changed by this work.                                                                                                                                                  | BDPN migration plan section 8                                                            |

**UNVERIFIED:** live database state in any environment, whether row-level security is enabled on `customers` or on the staff session tables, the exact Gate 2 classification of every table, and any retention rule imposed by law or contract.

---

## 3. Design constraints

1. **No second customer identity.** All new rows reference `customers.id`. `customers.phone` uniqueness and semantics are unchanged.
2. **No staff reuse.** No new row, column or secret is shared with `users`, `refresh_tokens`, `password_reset_tokens` or staff JWT secrets. The PBKDF2 and token-hash helpers may be reused as code.
3. **Additive only.** No change to `customers` or any existing table in this contract. That keeps the hot global identity table out of the change and avoids stacking a second schema change on the pending `0067`.
4. **No secrets at rest in plain form.** Passwords as self-describing PBKDF2 hashes. Refresh credentials as SHA-256 of a 256-bit random value, following the reasoning in `password-reset-tokens.ts`. No raw tokens, OTPs or passwords anywhere, including events.
5. **Soft delete is not used on security artifacts**, matching `refresh_tokens` and `otp_codes`. They expire and are revoked, not hidden.
6. **Gate 2 posture preserved.** New tables receive **no** grants to the restricted broker login, exactly like the staff session tables.
7. **Isolation by construction.** Every customer-side query is scoped by a `customer_id` taken from the verified session, never from the request.

---

## 4. Entity overview

```
customers (existing, unchanged)
   │ 1
   ├──── 0..1  customer_credentials        password hash and change history
   │ 1
   ├──── 0..N  customer_sessions           one row per signed-in device
   │              │ 1
   │              └── 1..N  customer_refresh_tokens   rotating chain per session
   │ 1
   └──── 0..N  customer_auth_events        append-only audit (customer_id nullable)

otp_codes, otp_request_cooldowns          (existing, unchanged, local OTP path)
```

Proposed names are provisional and follow the existing `snake_case` plural convention.

---

## 5. Entities

### 5.1 `customer_credentials` (PROPOSED)

One password credential per customer. Absence of a row means "no password yet" (every existing customer today).

| Field                                    | Type and rule                                     | Purpose                                                                                     |
| ---------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `customer_id`                            | uuid, **primary key**, FK to `customers`, cascade | Enforces one credential per customer by construction                                        |
| `password_hash`                          | text, not null, self-describing PBKDF2 string     | Algorithm, iterations and salt travel with the hash so Argon2id can replace it per hash     |
| `password_set_at`                        | timestamptz, not null                             | First time a password was set                                                               |
| `password_changed_at`                    | timestamptz, not null                             | Latest change. Used by step-up and by session revocation logic                              |
| `last_verified_at`                       | timestamptz, null                                 | Last successful password check, for the "recent verification" step-up window                |
| `failed_attempt_count`, `last_failed_at` | integer and timestamptz, optional                 | **Decision D-B3.** Only if progressive delay needs durable state. The limiter may be enough |
| `created_at`, `updated_at`               | timestamptz                                       | Standard timestamps. No `created_by`, because the customer is the actor                     |

Rules: the hash is never returned by any API or repository read model. A password change sets `password_changed_at` and triggers revocation of other sessions (invariant I6). A history of old hashes is **not** stored, because current guidance does not require it and it enlarges what a leak exposes. If the owner wants reuse prevention, that is a new decision.

### 5.2 `customer_sessions` (PROPOSED)

One durable row per signed-in device. The row id is the `sid` carried in the access token (01A section 6.1).

| Field                 | Type and rule                                                                                                                                            | Purpose                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `id`                  | uuid, primary key                                                                                                                                        | Becomes the `sid` claim                                                    |
| `customer_id`         | uuid, not null, FK to `customers`, cascade                                                                                                               | Owner of the session                                                       |
| `auth_method`         | text, check in (`otp`, `password`, `recovery`)                                                                                                           | How the session was established, used by step-up                           |
| `created_at`          | timestamptz, not null                                                                                                                                    | Start                                                                      |
| `last_used_at`        | timestamptz, not null                                                                                                                                    | Idle tracking, updated at refresh, **not** on every request                |
| `absolute_expires_at` | timestamptz, not null                                                                                                                                    | Hard cap (01A proposes 30 days, CA-02)                                     |
| `idle_expires_at`     | timestamptz, not null                                                                                                                                    | Moves forward on refresh. Value is a decision (CA-02)                      |
| `step_up_verified_at` | timestamptz, null                                                                                                                                        | Last re-verification inside this session                                   |
| `revoked_at`          | timestamptz, null                                                                                                                                        | Set once. A revoked session is never reactivated                           |
| `revoked_reason`      | text, check in (`logout`, `logout_all`, `password_changed`, `recovery`, `replay_detected`, `suspended`, `expired_cleanup`, `admin`), null unless revoked | Reconstructs incidents, same idea as staff `revokedAt` and `invalidatedAt` |
| `device_label`        | text, null, length-capped, derived                                                                                                                       | Human label for the device list. Never a raw user agent                    |
| `source_hint`         | text, null                                                                                                                                               | Coarse network hint under policy **D-B1** (see section 9)                  |

A session is **live** exactly when `revoked_at IS NULL` and `now() < absolute_expires_at` and `now() < idle_expires_at`, and the customer is `active` and not soft-deleted.

### 5.3 `customer_refresh_tokens` (PROPOSED)

The rotation chain for one session. Kept separate from `customer_sessions` so the durable session identity does not change when its credential rotates.

| Field                     | Type and rule                                      | Purpose                                                                        |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| `id`                      | uuid, primary key                                  | Token record id                                                                |
| `session_id`              | uuid, not null, FK to `customer_sessions`, cascade | Chain owner                                                                    |
| `token_hash`              | text, not null, **unique**                         | SHA-256 of the 256-bit credential. Lookup key at refresh. Unique, unlike staff |
| `issued_at`, `expires_at` | timestamptz, not null                              | Lifetime of this single token                                                  |
| `rotated_at`              | timestamptz, null                                  | Set when exchanged for a successor. Drives the concurrent-refresh grace window |
| `replaced_by_token_id`    | uuid, null, **no FK**                              | Trail marker only, consistent with `refresh_tokens`                            |
| `revoked_at`              | timestamptz, null                                  | Set when the whole session is revoked                                          |

A token is **usable** exactly when `rotated_at IS NULL`, `revoked_at IS NULL`, `now() < expires_at`, and its session is live. Presenting a token with `rotated_at` set **outside** the grace window is replay and revokes the session (I4).

### 5.4 `customer_auth_events` (PROPOSED)

Append-only audit trail for customer authentication. Built as a new table, not as a change to `audit_log`.

| Field         | Type and rule                                           | Purpose                                                                                    |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `id`          | uuid, primary key                                       | Event id                                                                                   |
| `customer_id` | uuid, null, FK to `customers`, **on delete set null**   | Null for events about an unknown phone. Survives customer purge, like `audit_log`          |
| `session_id`  | uuid, null, no FK                                       | Correlation only, so an event outlives its session                                         |
| `event_type`  | text, not null, check against a closed list (section 8) | What happened                                                                              |
| `outcome`     | text, check in (`success`, `failure`, `blocked`)        | Result                                                                                     |
| `reason_code` | text, null, closed list                                 | Machine reason, never free text from input                                                 |
| `subject_key` | text, null                                              | Keyed hash of the phone for unknown-account events, **decision D-B4**. Never the raw phone |
| `source_hint` | text, null                                              | Same policy as sessions (D-B1)                                                             |
| `metadata`    | jsonb, null, allow-listed keys only                     | Small structured context. No tokens, codes, passwords or full user agents                  |
| `created_at`  | timestamptz, not null                                   | Time                                                                                       |

Why not reuse `audit_log`: its actor is a staff user FK and it is scoped to businesses. Adding a customer actor would modify an existing, widely-read table and blur the trust-domain separation that 01A section 3 requires. A separate table keeps customer and staff audit apart and lets each have its own access rules and retention.

---

## 6. Invariants (must hold in database or in the single owning service)

| ID  | Invariant                                                                                                                         | Enforced by                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| I1  | At most one credential per customer                                                                                               | Primary key on `customer_credentials`                                                       |
| I2  | A refresh token hash identifies exactly one token                                                                                 | Unique constraint                                                                           |
| I3  | A refresh token is exchanged at most once                                                                                         | Conditional update on `rotated_at IS NULL`, atomic, same pattern as the guarded OTP consume |
| I4  | Reuse of a rotated token outside the grace window revokes the **whole session** and emits a replay event                          | Service rule plus test                                                                      |
| I5  | A revoked session stays revoked and its tokens never become usable again                                                          | No update path clears `revoked_at`                                                          |
| I6  | Password change, recovery and `logout_all` revoke every other live session of that customer in the same transaction as the change | Service rule, single transaction                                                            |
| I7  | A suspended or soft-deleted customer has no usable session. Checked at use, and sessions are revoked when status changes          | Per-request check plus revocation on change                                                 |
| I8  | `revoked_reason` is set if and only if `revoked_at` is set                                                                        | Check constraint                                                                            |
| I9  | Events are never updated or deleted by application code, only inserted, and expired by the retention job                          | Service and repository surface, optional trigger (D-B5)                                     |
| I10 | No new table stores a token, OTP, password or recovery code in recoverable form                                                   | Schema review and a test that scans columns                                                 |
| I11 | Customer queries are scoped by the session's `customer_id`, never a request value                                                 | Repository signatures and tests                                                             |

---

## 7. State machines

```
Session:   (none) ──create──► LIVE ──refresh──► LIVE (idle window moves)
                               │
                               ├─ logout / logout_all / password change / recovery / suspension ─► REVOKED
                               ├─ replay detected ────────────────────────────────────────────► REVOKED
                               └─ absolute or idle expiry (no write needed) ───────────────────► EXPIRED

Refresh token:  ISSUED ──exchange──► ROTATED (rotated_at set, successor issued)
                  │                      │
                  │                      └─ presented again inside grace ──► same successor (no new row)
                  │                      └─ presented again after grace ───► REPLAY ─► session REVOKED
                  └─ session revoked / expiry ─────────────────────────────► DEAD

Credential:  ABSENT ──set after verified OTP──► PRESENT ──change──► PRESENT (all other sessions revoked)
```

Expiry is evaluated from timestamps at read time. A cleanup job only **removes** long-dead rows (section 10). Correctness never depends on the cleanup having run.

---

## 8. Event vocabulary (closed list, PROPOSED)

`otp_requested`, `otp_verified`, `otp_failed`, `registration_completed`, `password_set`, `password_changed`, `password_login_succeeded`, `password_login_failed`, `recovery_started`, `recovery_completed`, `recovery_failed`, `session_created`, `session_refreshed`, `session_revoked`, `session_replay_detected`, `step_up_passed`, `step_up_failed`, `rate_limited`, `legacy_token_used`, `kill_switch_changed`.

Each type has a fixed set of allowed `reason_code` and `metadata` keys, defined in 01D with the code that writes it. A new type needs a reviewed change, not a free-form insert.

---

## 9. Privacy and data minimization

| Data                  | Treatment (PROPOSED)                                                                                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone number          | Already stored on `customers`. **Not** copied into the new tables. Unknown-account events use a keyed hash (`subject_key`) so attempts can be correlated without storing numbers someone typed |
| IP address            | The staff table stores it raw. For customers, store only a **coarse** hint (for example a truncated prefix) or nothing, under **D-B1**. A raw IP in a long-lived table is the larger exposure  |
| User agent            | Never stored raw. A short derived `device_label` for the device list                                                                                                                           |
| Password              | Hash only, in one table, never in any read model                                                                                                                                               |
| Events `metadata`     | Allow-listed keys. No secrets, no free text from users                                                                                                                                         |
| Marketing consent     | **Not** stored here. Consent stays in `consent_grants`. Registration records no promotional consent (requirement section 7)                                                                    |
| Account-level notices | Whether acceptance of a versioned registration notice is stored, and where, is **D-B6** and depends on CA-08. This contract reserves no column for it                                          |

The keyed hash for `subject_key` needs a server secret (a new secret, separate from every signing secret). Creating it is a 01D and owner task, not done here.

---

## 10. Access patterns, indexes and cleanup

| Pattern                                                  | Frequency       | Support                                                                                                                                           |
| -------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verify a session by `sid` at every authenticated request | Every request   | Primary key on `customer_sessions`. **Join with the existing customer status read in one query** so the request does not gain a second round trip |
| Refresh by credential                                    | Per refresh     | Unique index on `customer_refresh_tokens.token_hash`                                                                                              |
| List a customer's live sessions                          | Device list     | Index on `(customer_id, revoked_at)`                                                                                                              |
| Revoke all of a customer's sessions                      | Rare            | Same index                                                                                                                                        |
| Read credential at login                                 | Per login       | Primary key                                                                                                                                       |
| Events by customer, newest first                         | Support, review | Index on `(customer_id, created_at)`                                                                                                              |
| Events by type over time                                 | Monitoring      | Index on `(event_type, created_at)`                                                                                                               |
| Remove dead rows                                         | Scheduled       | Indexes on `absolute_expires_at` and on events `created_at`                                                                                       |

- **Cleanup.** The Worker already exports a `scheduled` handler for cron triggers (VERIFIED in `wrangler.toml` comments). A purge job would delete sessions whose absolute expiry plus a grace period has passed, cascading their tokens. Retention periods are **D-B2**.
- **Write pressure.** `last_used_at` is updated at refresh, not per request, to avoid a write on every call. The cost of the per-request session read is **not measured** and 01D must measure it (01A section 12).
- **Concurrency.** Rotation must be a single guarded update, the same pattern as the OTP consume. The repository already has concurrent-refresh tests for staff to copy as a model.

---

## 11. Migration list, Gate 2 impact and sequencing

### 11.1 Proposed migration list

One additive migration, name provisional, for example `0068_customer_auth_sessions`:

1. Create `customer_credentials`, `customer_sessions`, `customer_refresh_tokens`, `customer_auth_events` with their constraints and indexes.
2. **No change** to `customers`, `otp_codes`, `otp_request_cooldowns` or any existing table.
3. **No data backfill.** New tables start empty, so existing customers are untouched.

A second migration is **not** expected. If the owner chooses R2 email recovery (CA-04), its storage is a separate future migration and is not designed here.

### 11.2 Gate 2 impact

| Item               | Impact                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Journal pin        | Scripts assert exactly 68 applied migrations. The PR that adds the migration must **re-pin in the same PR**. The BDPN plan counts 22 matching files. Regenerate the list at that time, do not reuse the number             |
| Table inventory    | The restricted-login script requires **no grants** on any public table. New tables must be created with no grants to that login. The `>= 90` table count is a lower bound and is not broken by adding tables               |
| Direct-read denial | The script already denies direct reads of `customers` and `refresh_tokens`. Adding the same denial for the new session and credential tables is **recommended** so the posture is tested, not assumed                      |
| Runtime role       | The runtime login is recorded as the owner role with row-level-security bypass (pre-existing finding). This contract therefore does **not** rely on database-level isolation. Scoping is enforced in the application (I11) |
| Row-level security | Whether to add RLS on the new tables is **D-B7**. Because the runtime owner role bypasses it today, RLS would not currently block the application, so it is defense in depth only                                          |

### 11.3 Sequencing (important)

1. `0067` (customer preferred locale) is **pending in production and staging**. It must be applied and verified first.
2. **BDPN also proposes migration 68.** Both cannot be 68. Whichever lands second takes the next number, and the journal pin moves again in its own PR. The roadmap says no two schema or authorization changes should land together, so the owner must set the order.
3. D-C1 rollout is independent and must not be blocked or reordered by this work.
4. No migration is authorized by this document. Each environment needs its own authorized sequence, as the BDPN plan describes for `0067`.

### 11.4 Rollback posture (PROPOSED)

The migration is additive and the new tables are empty until the feature is switched on. Before any data exists, a reviewed forward fix can drop the tables. After credentials or sessions exist, prefer to **stop using** the tables and keep them, because dropping would delete customers' passwords and sessions. This mirrors the guidance the repository already records for `0067`.

---

## 12. Decisions needed

CA items are from the roadmap. D-B items are new in this block.

| ID    | Question                                                                  | Default used here (PROPOSED)                     | Needed before        |
| ----- | ------------------------------------------------------------------------- | ------------------------------------------------ | -------------------- |
| CA-01 | Confirm reuse of the PBKDF2 implementation with separate customer storage | Yes                                              | 01D                  |
| CA-02 | Access and refresh lifetimes, idle and absolute limits                    | 15 min access, 30 day absolute, idle limit open  | 01D                  |
| CA-04 | Recovery option. Only R1 needs **no** new storage                         | R1, with opt-in R2 later                         | 01C, 01D             |
| CA-08 | Whether and where notice acceptance is stored                             | Not stored in these tables (D-B6)                | 01D                  |
| D-B1  | Store IP-derived data on sessions and events at all, and how coarse       | Coarse hint or none                              | 01D                  |
| D-B2  | Retention for dead sessions and for events                                | Owner and legal input needed. No number proposed | 01D                  |
| D-B3  | Durable failed-attempt counters on the credential row                     | Limiter only, no counters                        | 01D                  |
| D-B4  | Record unknown-phone attempts as keyed hashes                             | Yes, with a new secret                           | 01D                  |
| D-B5  | Database trigger to enforce append-only events                            | Service-level only, trigger optional             | 01D                  |
| D-B7  | Add row-level security on the new tables                                  | Not required, defense in depth                   | 01D                  |
| D-B8  | Maximum concurrent sessions per customer, and behavior at the cap         | Cap and evict oldest, value needed               | 01D                  |
| D-B9  | Migration order against the BDPN migration and the `0067` rollout         | `0067` first, then the owner picks BDPN or auth  | Before any migration |

---

## 13. Interface 01C and 01D must respect

**For 01C (existing-customer migration).** No backfill is needed. A credential row is created only after a verified OTP and an explicit password choice. A customer without a credential row keeps working exactly as today. Creation must be safe to repeat: the credential primary key makes a second attempt a no-op or an update, never a duplicate identity. No existing token is invalidated by the migration. Legacy tokens have no session row, so their use is counted through `legacy_token_used` events.

**For 01D (API), repository operations the contract requires** (names are descriptive, not code):

- credentials: find, create, change, mark verified
- sessions: create, find by id joined with customer status, list live for a customer, revoke one, revoke all except one, revoke all, touch on refresh
- refresh tokens: issue, exchange atomically, detect replay and revoke the session, purge dead
- events: append, list by customer, purge by retention
- every method takes `customer_id` from verified context (I11)

---

## 14. Verification the implementation must provide (not performed here)

- Constraint and migration tests on a disposable PostgreSQL 18, including a clean replay of the full journal and an upgrade from the previous head.
- Concurrency tests for atomic token exchange, replay revocation and concurrent revocation, modeled on the existing concurrent-refresh tests.
- A test that no new column can hold a plaintext secret (I10) and that no read model returns `password_hash` or `token_hash`.
- Gate 2 re-run after the re-pin, including the restricted-login denial for the new tables.
- Cascade and soft-delete behavior: suspension revokes sessions, purge keeps events with `customer_id` set to null.
- Backward compatibility: a legacy token still authenticates while the tables are empty.

---

## 15. Risks, assumptions, residual risk

- **Assumes the 01A model is accepted.** If the owner prefers a denylist instead of rotation, section 5.3 shrinks and sections 7 and 10 change.
- **Per-request cost** of the session read is unmeasured.
- **Two migrations want number 68** (this and BDPN). The re-pin work doubles if ordering is not fixed first.
- **Owner-role runtime login** means the database is not an isolation boundary today. Application scoping carries the guarantee.
- **Retention and IP policy** have legal and privacy dimensions that Claude cannot settle. They are listed, not decided.
- **Nothing was run.** No migration was generated, no SQL executed, no test run for this block. All findings come from reading the repository at the stated baseline.

## 16. Future work

01C migration plan, 01D API and migration, 01E web, 01F business-QR path, 01G remote enrollment (needs a D-18 amendment), 01H certification. Each needs its own authorization.

## 17. Changelog

| Date       | Change                            |
| ---------- | --------------------------------- |
| 2026-11-12 | First draft of 01B (design only). |
