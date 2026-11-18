# CASHIER-AUTH-02D: customer onboarding attribution

Status: **IMPLEMENTED, development only.** Migration `0083` is NOT applied to staging or production. Not merged, not deployed.
Baseline: `origin/main` @ `fb7f4b994c8d9885433830d02e662a55164acc62` (02A, 02B, 02C merged). Journal 83 entries, so `0083` was free.

## Purpose and scope

Record **which business, branch and cashier** a customer's onboarding came from, without changing the network-wide customer identity or
the business-isolated loyalty ledgers. Every onboarding keeps the historical context it happened in; nothing is invented.

## Owner rulings recorded (02D)

| Ruling | Decision | How it is met |
|---|---|---|
| D1 storage | Append-only onboarding-event table; membership stays the current summary | `customer_onboarding_events`; `business_customer_memberships` untouched |
| D2 visibility | Minimum necessary customer data for cashiers | Cashier-side response carries no customer data; the customer response carries no cashier data; reporting returns counts only |
| D3 verification | Explicit state, independent of membership, never inferred | `verification_state` read from `customers.phone_verified_at` and `customer_credentials.login_email_verified_at` at event time; later verification never rewrites an event |
| D4 history | No invented historical events, no automatic `legacy_unattributed` | The migration inserts nothing; legacy memberships have no event rows (tested) |
| D5 retention | Preserve pending a retention ruling; no purge | No deletion path; FKs are `RESTRICT`; guard denies UPDATE/DELETE/TRUNCATE |

## Existing workflow findings (inspected before coding)

- There is **one** enrollment workflow: the **customer** scans a branch's business QR and joins while signed in as themselves, with
  explicit `JOIN_LOYALTY` consent (`POST /customer-memberships/join`, plus the legacy duplicate `POST /loyalty/me/join`). It is serialised per
  (customer, business) by an advisory lock, idempotent, and creates the membership, the consent grant and the loyalty account in one transaction.
- Business QR codes are **branch-specific** (`qr_codes.branch_id`), so the QR a customer scanned identifies a branch from the server's own row.
- `business_customer_memberships.onboarding_source/_reference` already exist and are overwritten on re-join. They remain the *current* summary.
- **No cashier-initiated membership creation exists.** A cashier can only serve a customer who already has a membership. There is no remote-invitation
  enrollment either.
- Verification facts live in `customers.phone_verified_at` (phone) and `customer_credentials.login_email_verified_at` (email). An additional
  business needs a verified phone (existing gate, unchanged).
- Customers are soft-deleted; no hard-delete or erasure flow exists (`docs/OPERATIONS.md`), so permanent events do not conflict with an erasure contract today.

## Data model: `customer_onboarding_events` (migration `0083_customer_onboarding_events`)

| Column | Notes |
|---|---|
| `id` | uuid PK, generated before insert so the audit row can reference it |
| `membership_id`, `business_id`, `customer_id` | NOT NULL, FKs `RESTRICT`; guard checks they agree with the membership row |
| `branch_id` | nullable; guard checks it belongs to `business_id` |
| `cashier_user_id` | nullable; set exactly when `source = 'cashier_assisted'` |
| `source` | `business_qr` \| `cashier_assisted` \| `remote_invitation` (**reserved**: no workflow writes it; tested) |
| `verification_state` | `unverified` \| `phone_verified` \| `email_verified` \| `phone_and_email_verified` |
| `consent_grant_id` | the `join_loyalty` grant; guard checks customer, business and purpose |
| `reference` | QR code id, or the one-time invitation id |
| `is_rejoin` | a fact recorded at insert (the membership already existed), not inferred from history |
| `occurred_at`, `recorded_at` | actual time and durable recording time |
| `audit_log_id` | the `customer.onboarded` audit row written in the same transaction |

Constraints and guards (all in the migration):
- CHECKs: source and verification vocabularies; cashier present iff cashier-assisted; assisted requires a branch and a reference.
- Unique partial index `(business_id, reference) WHERE source = 'cashier_assisted'`: an invitation onboards **one** customer (database-enforced).
- `customer_onboarding_event_guard` trigger (`ENABLE ALWAYS`): INSERT only; UPDATE and DELETE denied; tenant consistency; the cashier must be an **active** user who
  holds a live role grant for the business that covers the branch (managed identities must belong to that business). `TRUNCATE` denied by a second trigger.
- Indexes for authorised reporting by business, branch, cashier and membership.
- Deviation from the sketched columns: none removed. `audit_log_id` is populated because the audit row is written in the same transaction and its id is
  returned (`AuditLogRepository.recordReturningId`).

## Onboarding integration

1. **Self-service (branch QR).** Both existing join routes pass `attribution = { source: 'business_qr', branchId: <the QR row's branch>, reference: <QR id> }`.
   Nothing the request body says about branch or cashier is read (tested).
2. **Cashier-assisted.** A two-step handshake because the customer must give their own consent. The cashier's active session produces a short-lived (10 min),
   server-signed, one-time invitation (`type: onboarding_invite`, claims: cashier, session, business, branch, id; not valid as an access token). The customer accepts it with
   `POST /customer-memberships/join-assisted` (customer-authenticated, explicit consent, same idempotent serialised join). The cashier's authority is re-checked **inside the join
   transaction** under the 02C shared session lock (`assertCashierSessionBound`), then the cashier must be active, unlocked, of this business and hold `loyalty:serve` at the branch.
   A switch, sign-out, disable or revocation that commits first makes the invitation unusable (generic 409, nothing written); one that commits later cannot move the recorded branch.
3. **Re-join.** A new event is appended; the first is never touched; the unique membership, the loyalty account and the single customer identity are reused.
4. **Idempotency.** An event is appended only when the join creates the membership or reactivates a left one. A retry while already a member writes nothing.

## Architecture conflict reported (stopped for owner decision)

**Issuing the invitation requires a new cashier-callable route**, and the cashier route allow-list is pinned at exactly eight routes (`cashier-scope.test.ts`),
with the owner direction to preserve those restrictions and not broaden cashier privileges. Adding a ninth route (or a refresh-token-credentialed auth route like 02C's
switch) is a change to that frozen boundary, so it was **not made**. Consequences:

- The customer-side endpoint, signing/verification, authority re-check, database guards and reporting are implemented and tested with invitations signed exactly as the issuer will sign them.
- No server code mints an invitation today, so the `cashier_assisted` path is **dormant in production** until the owner rules.
- Options: **A** (recommended) add `POST /loyalty/actions/onboarding-invite` to the allow-list: access-token authenticated, `loyalty:serve`, branch from the session, no customer data;
  **B** a refresh-token-credentialed route under `/auth/cashier/` (outside the allow-list, but spends the long-lived credential on a non-auth action).

## Reporting foundation

`GET /analytics/onboarding?from&to&branchId` (existing `analytics:view` permission, existing tenant and branch scoping): events vs unique customers, re-join events,
events with no branch, and breakdowns by source, branch and cashier. Counts only; no customer identifier. Branch-restricted roles see their own branch and no per-cashier
breakdown. Cashier tokens cannot reach it (outside the allow-list).

## Retention and privacy (for legal and architecture review)

- Records are durable by design. There is **no** automatic purge, retention window, or deletion path; FKs are `RESTRICT`, so a future hard delete of a customer, membership,
  branch or business is blocked while events exist. Any erasure feature must decide how this table is treated (anonymise `customer_id`/`cashier_user_id` by a reviewed, audited path,
  or delete under a documented legal basis). This is flagged, not decided.
- Stored personal-data-adjacent facts: pseudonymous ids, a branch, a source, a verification category, timestamps. No phone, email or name is copied into the table or the audit row.
- Cashier attribution is staff data; it is visible only to `analytics:view` holders of the business.

## Not done / out of scope

Cashier PWA screen to show the invitation and customer web screen to accept it (UI, blocked on the issuance decision); `remote_invitation` workflow; any backfill;
staging/production deployment; rate-limit, secrets, consent or verification policy changes; MFA.

## Tests

`apps/api/test/integration/customer-onboarding-attribution.integration.test.ts` (real PostgreSQL, real middleware and join service) and
`src/customer-relationships/onboarding-attribution.test.ts`, plus the updated join route test.
