# CASHIER-AUTH-02D: customer onboarding attribution

Status: **IMPLEMENTED.** Migration `0083` is NOT applied to staging or production. The issuer (Option A) is added in a follow-up PR.
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

## Invitation issuer (owner-authorised addition, Option A)

The architecture conflict reported with 02D (issuing needs a cashier-callable route while the allow-list is pinned at eight) was resolved by the owner: **Option A**, one explicit
allow-list addition. Refresh tokens are never used to issue invitations.

`POST /loyalty/actions/onboarding-invite` (the ninth cashier route; `middleware/cashier-scope.ts`, pinned by `cashier-scope.test.ts` as exactly nine):

| Control | Implementation |
|---|---|
| Authentication | existing cashier **access token** (`authenticate`, live session check); refresh, invitation and web tokens are refused |
| Authorisation | `requirePermission('loyalty:serve')` against live grants; the per-request tenant context still applies |
| Business, branch, cashier, session | only from the verified token claims and the live session; the request body, query and headers are never read (a header naming another business or branch is `CASHIER_CONTEXT_MISMATCH`) |
| No branch | a cashier session with no branch gets `409 ONBOARDING_INVITE_BRANCH_REQUIRED`: no branch is guessed |
| Non-cashier callers | a staff web token gets `403 ONBOARDING_INVITE_CASHIER_ONLY`: an invitation must be bound to a revocable cashier session |
| Invitation | HS256, type `onboarding_invite`, 10 minutes, claims `sub, sid, biz, brid, jti, iat, exp` only; no customer data; not valid as any other token |
| Single use | enforced by the database when accepted (unique `(business_id, reference)` for assisted events); a second customer gets `409 ONBOARDING_INVITE_USED` |
| Invalidation | acceptance re-checks inside its own transaction under the 02C session lock: sign-out, branch switch, branch removal, session revocation, disable, credential reset and business suspension all make it unusable (tested for each) |
| Rate limiting | the existing lookup limiter binding on its own key `onboarding-invite:<business>:<user>` (10 per minute, separate from lookups); no new binding or configuration |
| Audit | `loyalty.onboarding_invite_issued`, cashier-marked, entity = the invitation id; never the token or customer data. Written synchronously before the token is returned; fail-closed |

Tests: `test/integration/cashier-onboarding-invite.integration.test.ts` (23, real PostgreSQL, real customer acceptance), plus the exact-route pins.

### Independent security review of the allow-list change (2026-11-19)

A reviewer with no context from the implementation (fresh agent, read-only, instructed to attack the change) reviewed commit `d22939e`. Verdict: **APPROVE WITH CONDITIONS**; no critical or high findings; every one of the owner's eleven required controls PASS.
Confirmed: the allow-list grew by exactly one fully anchored route (no wildcard; trailing slash, double slash, case, encoding, HEAD/OPTIONS and method-override variants are all refused); only a verified live cashier access token reaches the handler
(refresh, invitation, customer, impersonation and staff web tokens are refused); business, branch, cashier and session come only from signed claims; single use is database-enforced and a rolled-back attempt consumes nothing.

| Finding | Severity | Disposition |
|---|---|---|
| M-1 soft-deleted or archived branch did not end outstanding invitations | medium | **FIXED** (acceptance now requires an existing, active branch of that business) + test |
| L-3 acceptance omitted `users.is_deleted` and the session row's business | low | **FIXED** + test |
| L-2 audit row written after the response by fail-open middleware | low | **FIXED**: written in the handler before the token is returned; failure refuses the request (tested with an injected failure); the middleware row is suppressed |
| L-1 invitation signed with the shared `JWT_ACCESS_SECRET` (type check enforced in every verifier read) | low | deferred, defence in depth: a dedicated `ONBOARDING_INVITE_SECRET` or `aud`/`iss` claims in a later hardening block |
| I-1 the rate limiter is a per-location, eventually consistent Cloudflare binding (soft limit) | info | accepted; same as every other limiter here |
| I-2 an invitation is a bearer credential for 10 minutes (not bound to a customer) | info | by design; short TTL, single use |
| I-3 a malicious cashier could mass-attribute onboardings (about 10 invitations per minute) | info, speculative | matters only if attribution later feeds incentives: add a daily cap per cashier, an issued-versus-accepted anomaly report and exclusion of re-join events before any such use |
| I-4 no test of acceptance racing revocation | info | the 02D suite races a switch against acceptance for 6 rounds and 02C-R1 covers revocation ordering; a dedicated looped acceptance-versus-revocation test is a possible follow-up |
| `BranchService.deleteBranch` does not revoke sessions bound to the deleted branch (pre-existing; also affects purchases and redemptions, which the per-request tenant check already refuses) | medium, pre-existing | **not changed here** (outside this change); recommended as a separate reviewed block |

## Invitation interfaces (owner-authorised, stacked on the issuer)

**Cashier PWA, `/cashier/invite`** (an "Invite" tab, offered only to a session bound to a branch): a button creates one invitation; the screen shows a QR code of the customer link, a live countdown, "copy link" and "create a new invitation";
when it expires the code is removed and the screen says so. It is keyed by branch and its action is bound to the branch it was drawn for, so a branch switch discards the code and a stale window is redirected. The cashier never enters or sees a customer detail.
Server action `cashierIssueInviteAction` calls only `POST /loyalty/actions/onboarding-invite` under the cashier credential; refusals map to rate-limited, branch-required and unavailable; an ended session returns to sign-in. The web-side conformance test pins the cashier app to the nine allowed routes.

**Customer page, `/loyalty/invite/<token>`** (customer host): signed-out visitors see only sign-in and create-account links that return to the same page (nothing about the invitation is revealed before authentication). A signed-in customer sees the business and branch and the same
`JOIN_LOYALTY` consent as every other way of joining; **Join** stays disabled until it is ticked, and `joinAssistedAction` sends only the invitation, the consent and the consent version (the invitation decides business, branch and cashier). Handled states: ready, already enrolled, already used,
expired or invalid, no longer valid at acceptance, phone verification required for an additional business, generic failure. A cashier cannot create a customer identity: the customer authenticates as themselves and consents.

API additions for these screens: `POST /customer-memberships/join-assisted/preview` (customer-authenticated, read-only: business and branch names, `ready | already_member | used`, expiry; nothing about the cashier; a deleted or archived branch is refused) and the issuer response gains `inviteUrl`,
built from the operator-configured `WEB_BASE_URL` and the signed token only, so the cashier app needs no knowledge of the customer site's address.

Languages: English, French, Spanish, Arabic (`cashier.invite`, `cashier.header.invite`, `loyalty.customer.invite`), with a key and placeholder parity test; layouts use logical (RTL-safe) spacing, 48 px touch targets and a single-column card for 375 px screens.
Browser verification of RTL and 375 px layouts is part of the staging acceptance gate.

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

`remote_invitation` workflow; any backfill;
staging/production deployment; rate-limit, secrets, consent or verification policy changes; MFA.

## Tests

`apps/api/test/integration/customer-onboarding-attribution.integration.test.ts` (real PostgreSQL, real middleware and join service) and
`src/customer-relationships/onboarding-attribution.test.ts`, plus the updated join route test.
