# CASHIER-AUTH-02D final readiness remediation report (2026-11-19)

Baseline: `main` @ `1735ad2` (PR #525 merged by the owner). Authorization: read-only inspection, development, tests, draft PR. **No production write, migration, deployment, secret read or rotation, merge or 02E work was done.**
Verdict stays **NO-GO** for production (section 9). Nothing here authorizes a production action.

## 1. Authoritative state

- Echo Grid repository: `katohuzairu122-png/ECHOGRID-FEEDBACK-APP`. `main` = `1735ad2`; #520 to #525 merged; no later commits; journal 84 entries, last `0083_customer_onboarding_events`. `infinicus-llc/infinicus-validation` is the separate POS repository and was not touched.
- The branch-deletion session revocation (R2-1) is present on `main` (`branch-deletion.ts`, used by `DELETE /branches/:id`), verified in code and by the suites in section 6.

## 2. Production read-only preflight (metadata and SELECT only)

Identity: Neon project named `echo-grid-production` (`divine-voice-54333763`), protected primary branch `production` (`br-blue-paper-atrcoge1`), PostgreSQL 18.7, database `neondb`, history retention 6 hours. Production was identified by project name and by the repository's deployment documents, not by trusting historical identifiers alone.
Every statement was a SELECT. (`transaction_read_only` reports `off` because the tool does not open read-only transactions; no write statement was issued.)

| Check | Result |
|---|---|
| Migrations applied | **80** (journal entries 0000 to 0079; last `0079_customer_phone_verified_uniqueness`) |
| Pending vs repository (84) | **4 pending: 0080 business public profiles, 0081 B2B participation foundation, 0082 cashier managed identity, 0083 customer onboarding events** |
| 0083 table / 0082 columns present | absent (as expected) |
| Ledger integrity | All 80 `created_at` values equal the repository's journal `when` values. 72 stored SQL hashes match exactly; 8 (0000, 0006, 0011, 0012, 0018 to 0021) differ and **each matches the same file with CRLF line endings**: the documented historical normalization, not drift (`verify-production-migrations.mjs` identifies migrations by `created_at`) |
| Code vs schema | Production API and web were last deployed from `96be656` (run 44233836313, 2026-11-18); that commit's journal also has 80 entries ending at 0079, so code and schema agree today. `main` is 71 commits ahead of `96be656` |
| Data volume | 1 user (0 with a null email), 1 business, 1 active branch, 0 cashier session rows. Constraints added by 0082 (nullable `email`, managed-shape CHECK, unique username index) cannot be violated by existing data. No pre-existing guard triggers or tables with the new names |
| Workers | Production has `echo-grid-feedback-api` and `echo-grid-feedback-web` only. **There is no production cashier Worker** (`echo-grid-feedback-cashier` is absent) and the "Deploy production Cashier Worker" workflow has never run. `cashier.echo-grid.uk` is documented as not yet bound |
| Staging parity | staging is at 84 migrations with the same Workers (api, web, cashier-staging) |

Consequences:
1. **The 02D release cannot be applied alone.** Drizzle applies the pending journal entries in order, so production activation of 0082 and 0083 also applies 0080 and 0081 (B2B public profiles and participation foundation). The owner accepted 0080 and 0081 for **staging only**, with no precedent for production. Their production use needs its own authorization and a B2B scope decision.
2. Deploying current `main` ships 71 commits of other work with it. The release bundle must be defined by the owner.
3. A production cashier Worker, its custom domain and its secrets do not exist yet; the cashier app cannot go live until they are created.

Required order (existing gated workflows, each needing a separate owner directive): fresh Neon snapshot of the production branch (the 6 hour history window is too short to rely on) and recovery verification; migration run; API; web; cashier Worker. A new web before the new API would call missing routes; the old API against the new schema is safe because no managed identity exists until one is created.
Rollback: Worker versions roll back independently. The schema changes are additive, but 0083's guard denies DELETE and TRUNCATE, so once events exist the only database rollback is restoring the snapshot or dropping the object, which discards history: treat 0082 and 0083 as forward-only after first use.
Expected operational impact: tiny data volume; the `ALTER TABLE users` statements take brief exclusive locks; no long table rewrite (the `failed_login_count` column has a constant default). Not benchmarked on production.

Not done and why: Worker secret names (no tool or token available), GitHub environment approvals, Hyperdrive and DNS state, any write. These stay owner actions.

## 3. `CLIENT_ATTRIBUTION_SECRET`

- Who needs it: the **API Worker** (verifies) and **every Worker that runs the web app** (signs): production `echo-grid-feedback-web` and the future `echo-grid-feedback-cashier`; staging `echo-grid-feedback-api-staging`, `-web-staging`, `-cashier-staging`. The cashier Worker is the same Next app with its own configuration, so it signs cashier sign-ins itself. `docs/STAFF-LOGIN-THROTTLING-DESIGN.md` says "web Worker first, then the API" and does not name the cashier Worker: **add the cashier Worker to the rollout order**.
- Absent: the web sends no header, the API treats every caller as the web Worker's shared egress address (one strict bucket of 10 per minute for all sign-ins). This is an availability limit, not an authentication bypass; wrong credentials still fail. It fails safe.
- Present only on the API (wrong order): signed attribution is missing, so web requests are treated as direct callers and share the egress bucket (documented residual risk).
- Verifiability: the Cloudflare tools return only Worker names and ids; no token or `wrangler` is available to this session. **Presence is NOT VERIFIED on staging or production** and no value was read.
- Owner action (names only): `wrangler secret list --name <worker>` for the five Workers above, and confirm the same value is set on the signer and verifier. Not resolved.

## 4. Deliberate cashier lockout

Mechanism (code read): 5 failures in a rolling 15 minutes lock the identity for 15 minutes (`recordFailedManagedLogin`, one atomic statement; failures while locked are not recorded, so a lock cannot be extended). Every failure, including a locked identity, returns the same generic error after the same PBKDF2 work. A correct password never unlocks a locked identity. Only an administrator's credential reset (or disabling then enabling) clears a lock early.

Findings:
- **Exploit condition:** the business code (a public identifier by design) and a username. Five wrong passwords lock that cashier, repeatable every 15 minutes. The strict limiter (10 per minute per source) does not stop it; distributed sources are not needed.
- **Cross-user interference through the lock: none.** The lock is per identity. A new regression test proves a locked cashier does not affect a sibling cashier of the same business or the same username in another business, and that an unknown username records nothing.
- **Other cross-user path:** without the attribution secret, the shared sign-in bucket can 429 unrelated cashiers (availability, section 3).
- **Evidence gap:** a lock, and failed attempts, leave **no audit row** (only `RATE_LIMITED` events). The owner sees a `locked` flag in the account list; recovery is a credential reset, which also forces a new password and ends live sessions.
- **Implementation correctness:** the existing D-5 lockout is implemented as approved; no defect found, so no corrective change was made.

Recommendation (smallest compatible, subject to owner approval): **Option A** from the governance proposals: audit row on the lock transition, owner notification, and an audited, re-authenticated "unlock" that clears the counters without rotating the password. Then Option C once the secret is provisioned, with Option D (generated username suffix) as cheap hardening. Option B changes the approved D-5 policy and needs a ruling. None implemented.

## 5. Retention and erasure

Evaluation and the exact decision required are in `CASHIER_AUTH_02D_RETENTION_DECISION_RECORD.md` (section 7 added). No policy is approved; nothing implemented.

## 6. Security re-verification (this task, fresh local database)

Seven suites on `main` plus the new test, real HTTP against PostgreSQL: **188 passed, 0 failed** (managed-cashier 38 including the new test, branch-delete revocation 4, revocation race 21, branch switch, managed branches, issuer 30, attribution 44, and the remaining cases in the same files).

| Property | Evidence |
|---|---|
| Branch deletion ends sessions; switch-versus-delete races | `cashier-branch-delete-revocation` 4/4 |
| Branch-switch concurrency | `cashier-revocation-race` 21/21, `cashier-branch-switch` |
| Cross-business isolation, access-token scope, issuer authority | `cashier-onboarding-invite` (cross-business, header mismatch, nine-route pin) |
| Invitation signing, expiry boundary, single use, replay, attribution integrity, consent, phone verification | `onboarding-attribution` unit (new boundary test) and `customer-onboarding-attribution` 44/44 |
| Lockout scope | `managed-cashier` (new isolation test) |
| Purchase idempotency and redemption concurrency | staging acceptance (SQL-verified); not re-run here |
| Staff-email and customer-email boundaries | existing suites only; staging email regression NOT RUN (no provider access) |

New test coverage added: lockout isolation (integration). No defect was found in this pass, so no code change was needed.

## 7. Remediation PR

One draft PR (see the completion report): a test-only commit (lockout isolation) and the documentation updates. No production, schema or runtime behaviour change.

## 8. Items still not run

Live invitation expiry on staging (no secret access); phone-verification-required path on staging (no SMS fixture); staging email-provider regression; Worker secret names; production snapshot and recovery verification (not authorized); production Hyperdrive, DNS and GitHub environment state.

## 9. GO/NO-GO

**NO-GO.** Gates not met: secret presence unverified; retention and erasure undecided; D-5 deliberate-lockout mitigation not realized; the release bundle includes unapproved-for-production migrations 0080 and 0081 and 71 other commits; no production cashier Worker, domain or secrets; no production snapshot; no separate production directive.
