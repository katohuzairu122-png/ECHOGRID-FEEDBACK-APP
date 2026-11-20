# CASHIER-PROD-R8-G: non-owner application runtime role (2026-11-20)

Status: **IMPLEMENTED AND TESTED ON DISPOSABLE POSTGRESQL. NOT PROVISIONED, NOT CUT OVER, NOTHING SHARED TOUCHED.** No production or staging credential, Hyperdrive config, role or database was changed. No Drizzle migration was added (journal unchanged at 0085, ledger 86). Not legal advice.

## 1. Problem (verified)

Production and staging Hyperdrive origins connect as `neondb_owner`, which owns every table. An owner can disable or drop any trigger, replace any function, change grants and read or write every table, so the 0085 audit guard and every other database guard only protect against defects and non-owner roles, not against a compromised runtime credential.

## 2. Three separate database authorities

| Authority | Role | May | Must not |
|---|---|---|---|
| Schema migration | schema owner / migrator (existing; used only by the migration workflows) | DDL, migrations, provisioning | be bound to any deployed Worker |
| Application runtime | `echogrid_app_runtime` (NOLOGIN group, new) + an application LOGIN that is a member of it | the DML the code actually performs | own objects, create objects, alter or disable triggers, assume any role, read the dedicated-role families |
| Privacy/erasure | `onboarding_erasure_owner` / `onboarding_erasure_operator` (0084, memberless) | the one restricted erasure operation | be reachable from the runtime |

The Stripe-read, settlement and signed-evidence families keep their own dedicated roles; the runtime has no access to them (they are forced-RLS with policies aimed at those roles).

## 3. What the runtime role may do (derived from code, then proven)

`scripts/runtime-role/runtime-role-manifest.json` classifies **every one of the 119 tables**: 106 `RUNTIME` with exactly the verbs the application source performs (ORM calls and raw SQL, with `SELECT` wherever a write exists because PostgreSQL needs it for `RETURNING`/`WHERE`, and `UPDATE` where inserts use `ON CONFLICT DO UPDATE`), and 13 `NO_ACCESS` (the forced-RLS families, the erasure audit, dormant multi-unit tables, one unreferenced translations table). Sequences: only the four used by accessible tables. No function `EXECUTE` (no definer function is reachable). `audit_log` is `INSERT`/`SELECT` only. No table grants `TRUNCATE`, `REFERENCES` or `TRIGGER`. Schema: `USAGE` only, no `CREATE`.

The provisioning SQL and the verification SQL are **generated** from that manifest by `scripts/runtime-role/generate.mjs` (a test fails if the committed SQL drifts). Provisioning is idempotent, skips tables absent at lower migration levels, contains **no secret, no password and no real login name**, and is not in the Drizzle journal.

## 4. Evidence (real PostgreSQL, real LOGIN session; not SET ROLE from a superuser)

- New suite `runtime-role-security.integration.test.ts`: 15/15. It applies the committed provisioning twice (idempotent), runs the committed verification queries (all return zero rows), compares held privileges to the manifest table by table, pins the sensitive tables independently of the manifest, and attacks: disable/drop/replace the audit guards, change ownership, alter/drop protected tables, create objects, `TRUNCATE`/`UPDATE`/`DELETE` of audit history (denied at the **privilege** boundary, before any trigger), assume the owner, migrator, erasure owner/operator, settlement, Stripe-read and evidence roles (all denied), create roles, escalate attributes, grant itself privileges (nothing gained), `session_replication_role`, `ALTER SYSTEM`, forced-RLS tables with `row_security = off`, the 0084 erasure function (denied), definer functions (none executable). Positive: 25 concurrent runtime sessions inserting audit rows, registration, business, branch, role provisioning, customer join and leave with audit and onboarding event, and 6 concurrent joins serialized by the relationship advisory lock.
- Mutation checks: giving `audit_log` `UPDATE` (4 failures), giving the erasure audit `SELECT` (2), giving a forced-RLS table `SELECT` (3), and drifting the committed SQL (1) were each caught; restored 15/15.
- **Application regression under the runtime role:** the real-HTTP integration suites (cashier managed login, branches and switching, revocation races, onboarding invite, onboarding attribution, core loyalty acceptance, customer messaging, acceptance harness) were run with the app's database connection switched to the restricted login (`APP_RUNTIME_DATABASE_URL`) and fixtures on the admin connection: **211/211 pass** (same 211 as admin). A negative control (revoking `INSERT` on `audit_log`) made 24 of those tests fail with `permission denied for table audit_log`, proving the connection really is the restricted one.

## 5. Application compatibility under the runtime login (acceptance block, 2026-11-20)

Method: a test seam (`test/helpers/runtime-db.ts`, `appDbOf`) connects the **application services** to the restricted login while each suite's fixtures keep the admin connection; with `APP_RUNTIME_DATABASE_URL` unset (default and CI today) behaviour is unchanged. Scratch-database suites (their own databases) and operator-only tooling are not redirected.

| Area | Evidence under the runtime login |
|---|---|
| Full integration, all 129 files, services redirected in ~56 suites plus the real-HTTP suites | **1528 passed / 0 failed / 35 skipped** (same count as the default run) |
| Customer registration, email/password/recovery/session auth, phone gates, QR rotation, messaging, notifications preferences | covered (customer-* and messaging suites) |
| Business, branch, cashier accounts, branch switching, revocation, onboarding invites, onboarding attribution | covered (HTTP and service suites) |
| Loyalty earning, redemption, points engine, membership join/leave/consent, check-in gate | covered |
| Community membership, points award/reversal/admin adjustment/ledger, surveys, platform state | covered |
| Community Feed, publishing, platform moderation, official-post pinning (real HTTP lifecycle) | covered: 37 passed |
| B2B participation, partner enrollment, business-profile service, team invitations, orphan settlement (all stages), audit logging | covered |
| Stripe webhook evidence capture (`StripeEvidenceStore`) | covered: 133/133 across 10 files |
| Negative controls | revoking one privilege makes the service suites fail with `permission denied` (twice, with different tables) |

Two defects of the SEAM (not of the application) were found and fixed: a single cached connection serialized "concurrent" services, and unclosed connections exhausted a 100-connection server. No permission gap in the manifest was found on any covered path, so **no grant was added**.

**Still NOT verified under the runtime login:** the browser (Chromium) Community scenarios (14 tests, skipped locally because this sandbox ships Chromium 1243 while the repository's Playwright expects 1228; the hosted lifecycle workflow runs them with the default connection); billing repositories and platform MRR (repository-only suites, fixtures and subject share one handle); background-job persistence (queue consumer writes: notification status, sentiment results); the Stripe read-authorization and signed-evidence families (dedicated roles by design); suites that create their own scratch databases (partner credit, S08, split-01 backfill). A missed verb would show as `permission denied`; that is what the staging soak is for. Accepted residuals unchanged: `TEMPORARY` for PUBLIC; the schema owner and superuser can do anything; Neon's ability to run the provisioning on the production project is NOT VERIFIED.

## 6. Cutover certification (design verified locally; NOT executed)

Sequence (each step a separate Owner authorization): (1) as the schema owner provision the group role and verify (`verify-runtime-role.sql` must return zero rows); (2) create the application LOGIN out of band (password only in the secret store) and attach it; (3) create a **new** Hyperdrive configuration for that login (never edit the existing one); (4) bind a controlled **staging** deployment to it; (5) run the full acceptance suite and the cashier harness there, including queue consumers and scheduled jobs (these are the paths NOT yet verified above); (6) re-run the verification SQL and the negative controls; (7) review; (8) separate Owner authorization for production; (9) repeat provision, verify, new Hyperdrive config, deployment; (10) after a soak, remove the owner credential from every Worker binding and rotate it, keeping it only in the migration workflow secret; (11) verify production behaviour.

Rollback rehearsal (local): the same suite was run with the application on the owner connection and on the runtime login by changing one connection string, with identical results (1528/0/35 both ways), and the verification SQL stayed at zero rows. In production the equivalent is rebinding the Workers to the previous Hyperdrive config id and redeploying; no data changes, and the previous configuration is left untouched until the owner credential is deliberately rotated (after which rollback means restoring that credential from the secret store, so rotate only after the soak). Triage for `permission denied for table X`: it names a verb missing from the manifest; fix the manifest, regenerate, re-provision, re-verify; never a broad grant. Not executed: nothing here touches a Hyperdrive config, credential, role or Worker.

## 7. Migration coordination

R8-G adds **no migration** (provisioning is a script, because roles and grants are environment-specific and the login name is a placeholder). The pending release bundle stays 0080-0085 (ledger 86); D2-FINAL's next number is **0086**. Every new D2 table must be added to the manifest (the coverage test enforces it); D2 is stacked on this branch for that reason.

## 8. Remaining decisions

Owner must authorize provisioning, the new Hyperdrive configs, the staging soak, the production cutover and the owner-credential rotation. D1, D2, D3, D6 and R1-R8 (except the technical part of R8-G delivered here) remain open; P3 is not advanced.
