# CASHIER-PROD-RELEASE-P1: production release preparation and certification (2026-11-19)

Status: **P1 COMPLETE as a verification and planning gate. Production recommendation: NO-GO today; GO for P2 only after the Owner rulings in section 9.** Nothing in production or staging was modified. No migration, permission change, account, DNS, secret or deployment. P2 is not started.
Baseline: `main` @ `27fa440cce0ba97af00bdde8c1b741511b7d261a` (PR #532 merged; no open PRs). Production deployed code: `96be656` (2026-11-18).
Companion files: `docs/CASHIER-PRODUCTION-RELEASE.md` (corrected release plan) and `CASHIER_PROD_P4_cashier_manage_provisioning.sql` (reviewed, rehearsed, not executed).

## 1. Reconciliation (fetched 2026-11-19)

| Item | Finding | Source |
|---|---|---|
| main | `27fa440` (E2D, #532, merged 14:41Z). **Main-push CI run 1596 on this exact SHA FAILED**: every step passed (typecheck, 4073 API unit, 1227 web unit, receiver tests, integration, builds) except the browser step `block14:e2e`: 10 passed, 24 skipped, **1 failed**: `e2e/qr-engagement.spec.ts:17` ("QR code scan to feedback inbox"), `getByText('Excellent service, E2E test.')` not visible within 5 s, alongside local-queue `classify_feedback`/`send_notification` background job errors. The same tree passed on the PR head `808dd7c` (25/25), and the previous main pushes (`7a1d11c`, `fd0afec`, `041b444`) passed. This is the already-recorded unresolved "main-push-only browser failure" (`docs/CASHIER-PRODUCTION-RELEASE.md`, outstanding gaps); the test is unrelated to cashier and to E2D, but it is **not root-caused**, so it is recorded as a potential blocker for the exact-head CI gate. Not re-run by me (no CI mutation was authorized) | GitHub Actions run 44546473323 |
| Open PRs | none | GitHub |
| Journal | 84 entries, last `0083_customer_onboarding_events` | `apps/api/drizzle/meta/_journal.json` |
| Release workflows | `migrate-production.yml` (`MIGRATE_PRODUCTION`, protected `production` environment, **no snapshot, no CI gate**), `deploy-production.yml` (`DEPLOY_PRODUCTION_RELEASE`, CI gate, environment approval per job, binds to main tip), `deploy-cashier-production.yml` (`DEPLOY_PRODUCTION_CASHIER`, CI gate, environment approval, config guard, never binds a domain) | `.github/workflows` |
| Workflow/config changes since `96be656` | workflows: only the E2D CI steps (+14 lines, verification only) and a `network05` tweak; `apps/api/wrangler.toml` and `apps/web/wrangler.toml` **unchanged** (no new binding, route or variable); package files: one added script (`acceptance:cashier-02`) | `git diff 96be656 origin/main` |
| New production dependencies | none for the API/web Workers (`postal-mime` belongs to `apps/mail-receiver`, which no workflow deploys) | lockfile diff |
| PR #532 | merged; the receiver is test-only and is **not** a dependency of any cashier flow (nothing in `apps/api/src` or `apps/web/src` imports it) | code search |
| Production state (re-read-only today) | project `divine-voice-54333763` "echo-grid-production" PG 18.7; branch `br-blue-paper-atrcoge1` default, protected; ledger 80 rows, last 0079; 1 business, 1 user, **0 active branches**; permission catalog 34 keys with **no** `cashier:manage`, `profile:edit`, `profile:submit`; Workers `echo-grid-feedback-api` (2026-11-18T04:12Z) and `-web` (04:14Z) exist, **no** `echo-grid-feedback-cashier`; newest snapshot 2026-11-17T14:27Z (pre 0069-0079) | Neon + Cloudflare metadata |

## 2. Release candidate

**Proposed: the tip of `main` at P5, which today is `27fa440` plus the merge of the documentation PR from this block.** The deploy workflows accept only the current tip of main, so an earlier SHA cannot be released and a different one needs a new review. Re-record the 40-character SHA, and its green CI, at each gate.

Release strategy: **release main as a unit. No cherry-pick and no production release branch.** Architecture justification: the cashier work (02A to 02D, R1, R2) is interleaved with Split 01, BDPN and B2B history; the migrations are ordered; the workflows enforce main-tip; and a hand-built branch would deploy code that never passed the repository's CI as one commit. Consequence: the release carries other reviewed changes (section 3), and 02D (including its migration) cannot be left out.

## 3. Production change impact (current delta: 78 commits, 39 touch API, web or migrations; 164 files in api/web/drizzle/workflows)

The old figures (77 and 39 on the earlier head) were recomputed: 78 and 39. Mechanical churn is CRLF only in a few files; `git diff -w` confirms small real changes in billing and notifications.

| Area | What changed | Active or dormant in production | Schema/config needed | Backward compatibility and risk |
|---|---|---|---|---|
| Cashier identity and sessions (02A, 02B, 02C, R1, R2) | managed identities, branch assignment, switching, targeted revocation, locking order fixes; `auth.routes`, `cashier-auth.service`, `session-binding`, `branch-deletion` | **Active** (new routes), but harmless until an Owner creates an account | 0082; `cashier:manage` (P4) | Old staff and cashier flows are unchanged; managed identity has no email, so billing, notifications and impersonation were adjusted to skip it. Risk: MEDIUM (large surface), evidence below |
| Authorization | `cashier:manage` default Owner and Admin; `profile:edit/submit`; `cashier-scope` (nine routes); `authenticate` carries session id | Active | catalog rows (P4) | Manager, Staff, Cashier denied by default (matrix test). Risk: LOW |
| Customer onboarding attribution (02D, 0083) | append-only event written on **every** membership join, including the existing business-QR join; invitation issuer + customer accept page; analytics `/analytics/onboarding` | **Active from the first customer join**, not only for cashier invitations | 0083 | See D2. Risk: HIGH until ruled |
| Customer identity and membership (Split 01 C1 to C7, #514) | explicit `JOIN_LOYALTY` consent on every join, membership gates on check-in, earn, spend and redeem, idempotent join, withdrawal ends spending, customer DTO projections | **Active** and customer-facing | none beyond existing tables (0034 backfill existed) | Behaviour change for customers (consent now mandatory; spending needs an active membership). Needs Owner awareness. Risk: MEDIUM |
| Loyalty and rewards | lock ordering and races (`loyalty-account.service`, redemption) | Active | none | Fixes only. Risk: LOW |
| B2B participation (0081, S9-A1) | tables, terms versions, guards | **Dormant** (no route mounted: `index.ts` adds only `cashier-accounts`) | 0081 | Tables only. Risk: LOW (D6) |
| Business public profiles (0080, BDPN) | tables, validation, services, permissions `profile:edit/submit` | **Dormant** (no route mounted) | 0080 | Tables, 12 functions/triggers. Risk: LOW (D6) |
| Community / Network | web UI and API tests, retry/refresh behaviour (`apps/web`) | Active in the web Worker | none | UI behaviour; covered by existing browser tests in CI. Risk: LOW |
| Billing and Stripe | email may be null for managed identities (`billing.routes`) | Active | none | No payment logic change. Risk: LOW |
| Workers and routes | none (wrangler unchanged); new cashier Worker is new | n/a | cashier Worker deploy | See section 8 |
| API contracts | additive routes: `/cashier-accounts/*`, `/analytics/onboarding`, `/customer-memberships/join-assisted/*`, managed login | Active | none | Additive. Existing routes keep contracts except Split 01 consent/membership gating |
| Feature flags | none introduced for cashier; `CUSTOMER_EMAIL_AUTH_ENABLED` existing and unchanged | n/a | n/a | n/a |

Changes needing approval **beyond** the cashier release: the Split 01 customer-facing consent and membership behaviour; the dormant B2B and profile tables (D6); the active onboarding-event recording (D2). The Owner should explicitly accept these as part of D6.

## 4. Migration bundle certification (0080 to 0083)

| # | Purpose | Contents (actual SQL reviewed) | Destructive? | Notes |
|---|---|---|---|---|
| 0080 | business public profiles | 5 tables, 9 indexes, 12 functions/triggers, immutability guards | No DROP/TRUNCATE/DELETE/data UPDATE | Dormant |
| 0081 | B2B participation | 2 tables, 2 indexes, 7 functions/triggers | No | Dormant |
| 0082 | managed cashier identity | `users.email DROP NOT NULL` (relaxation), 9 new nullable/defaulted columns, 1 unique index, 2 FKs (RESTRICT), 5 CHECK constraints, guard and TRUNCATE-deny triggers on `users` and `user_business_roles` | No (relaxes one constraint; adds guards that only fire for managed identities or TRUNCATE) | `failed_login_count` NOT NULL DEFAULT 0: on a tiny table this is a metadata change |
| 0083 | onboarding events | 1 table, 6 indexes, 4 guards (append-only, tenant keys) | No | Active use begins with code (D2) |

Order `0080, 0081, 0082, 0083` matches the journal and is the only order drizzle applies. Existing production data: 1 user and 1 business satisfy every new constraint (a non-managed user keeps email non-null).

**Rehearsal on a production-shaped local database** (0000-0079 applied by `psql`, seeded with the same shape as production: 1 platform-admin user, 1 business, 4 system roles, the exact 34 production permission keys, 85 grants, 2 soft-deleted branches, 0 active branches, one business-wide Owner grant):
- 0080 78 ms, 0081 65 ms, 0082 48 ms, 0083 59 ms, **250 ms total**, each in its own transaction; all OK.
- A hash over user, business, role and permission identifiers was **identical** before and after; grants unchanged (85); `users.email` became nullable; the 4 managed columns and 3 new tables exist.
- Locks: short `ACCESS EXCLUSIVE` on `users` and `businesses` for the column additions; negligible at this size. Index creation is on empty or tiny tables.

**Runtime compatibility during the deployment interval (P3 applied, P5 not yet deployed).** The currently deployed code (`96be656`) was checked out and its full integration suite run against the migrated schema (0083) and, separately, against a pre-migration schema (0079), on identical fresh scratch databases: **10 failures in both, the same ten tests** (HETA certification and role scripts, Stripe evidence keyring/forensic operators, core-loyalty and Split 07 hardening tests that need a specific scratch database or an environment this container lacks). The remaining 83 passed in each. Earlier run of the full old-code suite on the migrated schema: 1069 passed, 11 failed, all in the same ten-test families plus database-name guards of the harness; 62/62 on the team, branch, category and loyalty suites run first. **Conclusion: the migrations do not break the code that is live today.** The interval can be as short as P3 immediately followed by P5.

Migration verification (read-only, after P3): ledger = 84 and last `created_at` = journal `0083`; `db:verify:production` (the workflow runs it); existence of `users.managed_business_id`, `businesses.cashier_code`, `customer_onboarding_events`; trigger list on `users` (`users_managed_identity_guard_trg`, `users_no_truncate`) and `user_business_roles`; row counts unchanged (1 business, 1 user, 4 roles, 34 permissions).

Recovery: forward fix first; the P2 snapshot is the only data-level recovery and discards later writes (section 10). Additive objects can stay in place.

## 5. Authorization provisioning plan (`cashier:manage`)

The seed script adds three keys (`profile:edit`, `profile:submit`, `cashier:manage`); production has none. The role defaults in code grant `cashier:manage` to Owner and Admin only. The reviewed script `CASHIER_PROD_P4_cashier_manage_provisioning.sql` inserts the one permission row and grants it to the **live system Owner and Admin roles of the one verified business**, in one transaction with preconditions (cashier schema present, business active, exactly one live system Owner and Admin role) and assertions (permission exists once; only those two roles hold it; no other permission or grant changed). It is idempotent.

Rehearsed on a local copy with **two businesses and a custom non-system role named "Custom Admin"**: first run `permissions_added 1, grants_added 2`; second run `0, 0`; the other business, Manager, Staff and the custom role hold nothing; a wrong business id aborts ("not an active business"); a database at 0079 aborts ("migrations 0082/0083 are not applied"); the permission exists once.

Not used: `db:backfill-role-permissions` (broad; rewrites every default role) and `db:seed` (needs a production connection string outside the reviewed workflows). `profile:edit/submit` are deliberately **not** added: their routes are not mounted. Consequence: a business created after the release would not receive them (its other defaults would be granted) until a later seed; recorded as LOW. Choose at P4 whether to also insert those two catalog rows (catalog only, no grants); the default recommendation is not to.

Post-provisioning checks (read-only, counts and role names only): permission count 35 and `cashier:manage` once; Owner and Admin hold it; Manager and Staff do not; other permissions and grant counts unchanged (85 baseline is local; record production's before and after); the Owner opens `/dashboard/cashier/accounts` successfully; a Manager (if any) is refused. No platform-wide privilege change: `platform_role` is untouched.

## 6. D1: `CLIENT_ATTRIBUTION_SECRET`

**NOT VERIFIED.** The Cloudflare tools available here return only a Worker's name and id; no tool exposes secret names or bindings, and the value was never requested. Owner verification (names only): `wrangler secret list --name echo-grid-feedback-api`, `--name echo-grid-feedback-web`, and, after it exists, `--name echo-grid-feedback-cashier`. Required on all three, same value (the web and cashier Workers sign the real client address; the API verifies). The cashier Worker **does** need it (the earlier plan said it needed no secret: corrected). If absent the application still works, but every sign-in shares one strict bucket of 10 per minute (about 5 multi-branch sign-ins per minute for the whole platform); a pilot with one cashier is workable, a busy shop is not. Classification: MEDIUM-HIGH, required Owner action before more than one cashier is on the system.

## 7. D2: onboarding-event retention and erasure

Facts: `customer_onboarding_events` rows are append-only (UPDATE, DELETE, TRUNCATE denied) and reference the customer, membership and branch with RESTRICT. The service appends one on **every** membership join (`customer-membership.service.ts`), for source `business_qr` as well as `cashier_assisted`. So the obligation starts at the first customer join after deployment, **not** only when a cashier invites someone: leaving invitations unused does not avoid it. No erasure flow or retention policy exists (`docs/OPERATIONS.md`; `CASHIER_AUTH_02D_RETENTION_DECISION_RECORD.md`). Production has 1 business and 0 active branches, so no joins can occur yet.

Required ruling before P5 (Owner): either (a) accept recording with a stated retention rule and an erasure approach to be built later (recommended minimal text: events retained for the life of the membership; erasure by a dedicated, reviewed anonymisation procedure that sets references to a tombstone under a separate guard), or (b) defer 02D, which would require a separate release strategy (not recommended, see section 2). Until then the deployment of 0083 plus code is **blocked by Owner ruling**, classification HIGH. Basic cashier login and serving do not depend on this table.

## 8. D3: deliberate lockout, monitored pilot proposal (nothing weakened)

Policy as built: 5 failures in 15 minutes lock the identity (business code + username) for 15 minutes; a correct password does not unlock; an administrator credential reset clears the lock. Anyone who knows a business code and a username can lock that cashier repeatedly. Not accepted by this document; it needs the Owner's explicit decision.

Proposed pilot acceptance (one dedicated test cashier, one branch, no real customers): (1) recovery: the Owner knows the reset path and tests it once before relying on it; (2) detection: read-only query for `users.locked_until > now()` among managed identities, and audit rows for `auth.cashier_login` (counts of failures per hour); (3) alerts: Owner checks daily during the pilot (an automated alert is a later change; no alerting exists today); (4) abuse-rate monitoring: strict-limiter 429 responses visible in the API logs; (5) incident response: if a lock occurs unexpectedly, reset the credential, rotate the business cashier code if the code is suspected known, and disable the account if abuse continues; (6) choose a non-obvious username; (7) accept an exposure window until the recommended follow-ups (notify and one-click unlock, then per-source counting after D1) are built. Pilot exit: no unexplained lock in 7 days.

## 9. D6: owner decision record, scope of the release

Decision requested: authorize preparing a release of **main as a unit** that applies migrations **0080, 0081, 0082, 0083** and deploys API, web and the new cashier Worker. Consequences: B2B (0081) and business-profile (0080) tables are created in production although nothing uses them yet (staging-accepted only; this document is their first production review: additive, dormant); customer-facing consent and membership gating change (Split 01); 02D records onboarding events from the first join (D2); the cashier surface exists but is unusable until an Owner creates a branch and an account. Alternatives: (A) this bundle (recommended); (B) delay until D2 is ruled; (C) a cashier-only branch (rejected, section 2). Required rulings: D6 (this bundle), D2 (retention text), D1 (secret confirmed), D3 (pilot acceptance). Prior staging acceptance is evidence, not authorization.

## 10. Recovery and rollback plan

- **P2 snapshot**: `mcp`/console snapshot of branch `br-blue-paper-atrcoge1` of project `divine-voice-54333763`, named e.g. `prod-pre-0080-0083-<date>`; record its id and `created_at`; list snapshots to confirm; confirm the source branch id before and after. Not created in P1.
- **Migration failure**: drizzle applies pending migrations in order; a failure stops the run and the open transaction rolls back that statement set; nothing is deployed; re-read the ledger; fix forward. If the schema is partially applied and cannot be fixed forward, restore from the snapshot (Neon creates a new branch from the snapshot; verify the project and parent before repointing Hyperdrive or promoting it; do not delete the original until verified).
- **Application rollback**: redeploy `96be656` via `deploy-production.yml` for the API and web; remove the cashier domain and Worker; no schema rollback needed (proved above).
- **Custom domain rollback**: remove the custom domain from the cashier Worker (dashboard); the DNS record is removed with it.
- **Secrets/configuration**: secrets are not committed; keep the previous value in the Owner's secret store until the release is accepted; `CLIENT_ATTRIBUTION_SECRET` can be removed from the API to return to the legacy per-address key.
- **Permission rollback**: delete the two grant rows and the permission row (or leave them: harmless without the new code).
- **Writes after release**: a snapshot restore discards every write after the snapshot (joins, sign-ins, audit rows, new businesses). Application rollback keeps them. Prefer application rollback and forward fixes. No maintenance window is needed for additive migrations; run P3 and P5 back to back.
- Neon history retention is 6 hours, so the manual snapshot is the only recovery point beyond that.

## 11. Worker and hostname readiness

| Item | Finding |
|---|---|
| API Worker | exists; production Hyperdrive config `echo-grid-feedback-db` points at the production compute `ep-gentle-queen-at8muqyy` (same project and branch as audited); staging uses a different config |
| Web Worker | exists; no `CASHIER_HOST`/`CASHIER_APP_URL` (correct until the cashier host is verified) |
| Cashier Worker | **does not exist**; created by the first `deploy-cashier-production.yml` run (workflow deploys with `opennextjs-cloudflare deploy --env cashier`; it refuses a config that could bind a domain; it does not bind DNS). Local build: OpenNext build OK; `wrangler deploy --dry-run --env cashier` lists bindings `ASSETS`, `API_BASE_URL`, `APP_URL`, `NODE_ENV`, `NEXT_PRIVATE_MINIMAL_MODE`, `CASHIER_HOST`, `CASHIER_APP_URL`; upload 14.2 MiB (2.87 MiB gzip) |
| Hostname `cashier.echo-grid.uk` | DNS, TLS and attachment state **NOT VERIFIED**: this container's network policy blocks outbound HTTP and DNS for these hosts, and the Cloudflare tools expose no zone or route listing. Owner check: Cloudflare dashboard, Workers and the `echo-grid.uk` zone DNS records, confirm no existing record or Worker already uses the name. The attachment (custom domain on the cashier Worker, which creates the record) is a manual dashboard step by the Owner |
| Secrets | `CLIENT_ATTRIBUTION_SECRET` on three Workers (D1); no other new secret for the cashier Worker |
| Session and cookies | cashier cookies are `httpOnly`, `secure` in production, `sameSite=lax`, with no `domain` attribute (host-only), so they are not shared with the main site; server actions 404 off the cashier host; staff surfaces redirect into the cashier app on that host; cashier tokens reach only the nine allow-listed routes (not `/cashier-accounts/*`) |
| Host isolation | `https://echo-grid.uk/cashier/login` must be 404 (render-time guard, minimal-mode runtime); verify at P6 |
| Web `CASHIER_APP_URL` | needs a **subsequent** one-line change after the cashier host is verified, then a web release |

## 12. Documentation corrected in this block

`docs/CASHIER-PRODUCTION-RELEASE.md` rewritten (migrations 0080-0083, nine-route allow-list, managed identities, branch assignment and switching, targeted revocation, permission provisioning, secret requirement, gates P2-P7, rollback, acceptance). The header comment of `.github/workflows/deploy-cashier-production.yml` corrected (comment only; **no step, trigger, permission or behaviour changed**). New: this document and the P4 script. No other workflow, config or code file changed.

## 13. Local verification (current main tree `27fa440`, isolated local PostgreSQL; labelled local, not production)

| Check | Result |
|---|---|
| API / web / receiver typecheck | PASS / PASS / PASS |
| ESLint | 0 errors, 44 warnings (pre-existing) |
| API `wrangler deploy --dry-run` | PASS |
| Web OpenNext build (the cashier Worker artifact) and cashier-env dry-run | PASS |
| `db:check` (migration drift) | PASS |
| API unit | 4073/4073 (ran earlier on the identical tree) |
| Web unit | 1227/1227 (same tree) |
| Full API integration on the current tree | 1457 passed, 6 failed, 41 skipped. Four failures are the Stripe-evidence environment failures (keyring file mode and native module); three are leftovers of earlier runs in the reused database (unique-key conflicts on `community_point_rules` and `partner_credit_policies`) and pass on a fresh seeded database (community point award and repositories files, and the partner enrollment lifecycle file, all PASS). Cashier 02A-02D, R1 race, R2 branch deletion, tenant gates, permission matrix, session refresh/replay and customer auth suites all passed |
| Currently deployed code (`96be656`) against the migrated schema | same results as against the pre-migration schema (section 4) |
| Migration rehearsal and P4 rehearsal | PASS (sections 4 and 5) |
| Hosted CI, exact head | PR head `808dd7c`: 25/25 green. Main push `27fa440`: **FAILED** on one flaky browser test (section 1). A green exact-head result for the final release SHA is a P5 prerequisite |
| NOT run | real-device camera/offline checks; the main-push browser job on production; anything against production or staging; no financial or customer transactions |

A green CI badge is not runtime proof in production.

## 14. Findings and blockers

| # | Finding | Class | Type |
|---|---|---|---|
| F1 | Migrations 0080-0083 pending | CRITICAL | Confirmed blocker (resolved by P3) |
| F2 | Cashier code not deployed (production at `96be656`) | CRITICAL | Confirmed blocker (P5) |
| F3 | `cashier:manage` absent for all roles | CRITICAL | Confirmed blocker (P4) |
| F4 | No cashier Worker; hostname state unverified | CRITICAL | Confirmed blocker (P5 and Owner dashboard step) |
| F5 | Zero active branches | HIGH | Confirmed prerequisite (Owner creates a branch at P7) |
| F6 | Onboarding events recorded on every join; no retention or erasure rule | HIGH | Required Owner ruling (D2) |
| F7 | `CLIENT_ATTRIBUTION_SECRET` presence unknown | MEDIUM | Potential blocker, Owner verification (D1) |
| F8 | Deliberate lockout possible | MEDIUM | Required Owner acceptance (D3) |
| F9 | Bundle carries B2B/profile tables and Split 01 behaviour change | MEDIUM | Required Owner ruling (D6) |
| F16 | Main-push CI red on `27fa440` (QR engagement browser test, recurrent main-push-only failure, not root-caused) | MEDIUM | Potential blocker: needs a green run on the release SHA (re-run or the docs-PR merge push) and a separate root-cause task |
| F10 | `migrate-production.yml` takes no snapshot and runs no CI | MEDIUM | Process control: P2 and green CI are manual preconditions |
| F11 | No snapshot for this release; 6-hour history | MEDIUM | P2 |
| F12 | Newly created businesses would lack `profile:edit/submit` | LOW | Accept or add catalog rows at P4 |
| F13 | DNS, TLS, real-device behaviour not verified | MEDIUM | Potential blockers, Owner checks |
| F14 | Stale release documentation | LOW | Corrected here |
| F15 | MFA absent | LOW | Future block |

Optional or unrelated: acceptance harness, test mail receiver, automated email-confirmation acceptance, analytics extras (deferrable; none is a prerequisite of cashier login and serving).

## 15. Readiness matrix and recommendation

| Gate | State | Needs |
|---|---|---|
| P1 repository and security verification | **COMPLETE (this document)**, except a green exact-head CI on the final release SHA (main-push CI on `27fa440` is red on one unrelated browser test) | none |
| P2 production snapshot | NOT STARTED | Owner authorization; rulings D1/D2/D3/D6 should come first |
| P3 migrations | NOT STARTED | Owner authorization, P2 verified, green CI on the SHA |
| P4 permission provisioning | NOT STARTED | Owner authorization, P3 verified, verified business id |
| P5 deployment | NOT STARTED | Owner authorization, P3/P4 done, secret confirmed, environment approvals |
| P6 smoke tests | NOT STARTED | Owner authorization |
| P7 Owner acceptance | NOT STARTED | all above |

**Recommendation: NO-GO for production today** (nothing is deployed or migrated; four confirmed blockers are the planned gates; two Owner rulings, D2 and D6, are required before P3). **GO to proceed to P2** once the Owner (a) confirms D6, (b) rules on D2 text, (c) confirms the secret names exist (D1), (d) accepts or defers D3, and (e) authorizes P2 explicitly. The smallest safe release is main as a unit with the sequence P2, P3, P4, P5, P6, P7.
