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

## 5. Not verified (stated plainly)

Privileges are derived from static analysis plus the suites above. Application paths not covered by those suites (for example community, partner enrollment, network publishing, business profile moderation and billing/Stripe webhooks) were **not** run under the runtime role: a missed verb would show as `permission denied` at runtime. Mitigations: the coverage test forces every table to be classified; the cutover is staged on **staging first** with the full suite and a canary before production; rollback is a binding change. Dormant paths that need the dedicated families (Stripe read authorization, settlement authorization, signed evidence) will need their own bindings if ever enabled. Accepted residuals: PostgreSQL grants `TEMPORARY` to PUBLIC (session-private objects; cannot be revoked per role); the schema owner and superuser can still do anything (that is the point of keeping them off the runtime). Whether Neon permits the exact provisioning on the production project (role creation rights of the owner) is NOT VERIFIED.

## 6. Cutover design (NOT executed; each step is a separate Owner authorization)

Preconditions: 0080-0085 applied through the approved P3; manifest regenerated if any later migration adds tables; hosted CI green on the release SHA.
1. **Staging first.** As the schema owner run `provision-runtime-role.sql` (login created beforehand with a generated password stored only in the secret store; placeholder replaced). Run `verify-runtime-role.sql`; every query must return zero rows.
2. Create a **new** Hyperdrive config for the runtime login (do not edit the existing one), bind it to the **staging** API/web/cashier Workers in a deployment, and run the full acceptance suite plus the cashier acceptance harness against it. Watch for `permission denied`; grant only the minimum, regenerate from the manifest, never a broad grant.
3. Repeat on production only after staging passes: provision, verify, new Hyperdrive config, deploy Workers bound to it, smoke tests (health, sign-in, branch switch, join, audit write).
4. After a soak period, **rotate the owner credential** and remove it from every runtime binding; the owner credential remains only in the migration workflow secret.
Rollback at any point: rebind the Workers to the previous Hyperdrive config id and redeploy (seconds, no data change; the new role and config can stay unused). Nothing here deletes data. Failure triage: `permission denied for table X` means a verb the code uses is missing from the manifest; fix the manifest, regenerate, re-provision, re-verify.

## 7. Migration coordination

R8-G adds **no migration** (provisioning is a script, because roles and grants are environment-specific and the login name is a placeholder). The pending release bundle stays 0080-0085 (ledger 86); D2-FINAL's next number is **0086**. Every new D2 table must be added to the manifest (the coverage test enforces it); D2 is stacked on this branch for that reason.

## 8. Remaining decisions

Owner must authorize provisioning, the new Hyperdrive configs, the staging soak, the production cutover and the owner-credential rotation. D1, D2, D3, D6 and R1-R8 (except the technical part of R8-G delivered here) remain open; P3 is not advanced.
