# CASHIER-AUTH-02E E1: staging acceptance harness

Repeatable, staging-only acceptance checks for CASHIER-AUTH-02A to 02D. ADR: `docs/architecture/decisions/CASHIER_AUTH_02E_ADR_001_SCOPE_DIRECTION.md`. Specification: `docs/architecture/builds/CASHIER/CASHIER_AUTH_02E_E1_IMPLEMENTATION_SPECIFICATION.md`.
It adds no product behaviour, changes no schema, and touches nothing under `src/`.

## State today: live execution is DISABLED

`staging-targets.json` ships with `"approved": false`. The three hostnames in it are taken from the repository's own Worker configuration (`apps/api/wrangler.toml`, `apps/web/wrangler.toml`); they are **not yet approved by the owner**, and no test mailbox is approved.
Until the owner records approval in that file (a reviewed commit that sets `approved`, `approvedBy`, `approvedAt`), a live run stops with `BLOCKED (LIVE_NOT_APPROVED)` before sending any request.

```bash
pnpm --filter @echo-grid-feedback/api acceptance:cashier-02           # offline self-check: no request is made
pnpm --filter @echo-grid-feedback/api acceptance:cashier-02 -- --env staging --scenarios S01,S02 --require-all
```

Exit codes: `0` every runnable check passed; `1` a check failed (or NOT RUN with `--require-all`); `2` blocked by a safety refusal; `3` interrupted.

## Safety controls (each enforced in code and unit-tested)

1. **Fixed staging allow-list** from the committed configuration; exact host match; https on the default port only; no credentials, fragment or redirect (redirects are errors).
2. **Production rejected twice:** a deny-list (`*.echo-grid.uk`, the production Worker names, any `prod`/`production`/`live` name) and the exact-match allow-list.
3. **No host overrides:** any host flag, URL-looking argument or host environment variable is refused (`OVERRIDE_REJECTED`).
4. **Staging identity:** the API's `/health` must report `environment: "staging"`; otherwise the run does not start.
5. **No secrets in output:** logs, errors and result files are redacted (JWTs, bearer values, emails and ids reduced to a short hash, phones, codes, long opaque strings); the writer refuses a file that still contains sensitive material. Credentials come only from the environment variables below and are never printed.
6. **Real flows only:** public API routes with real authentication and explicit consent. No database access, no fixtures inserted, no deletes, no cleanup, no schema or migration action. Everything created carries the run prefix.
7. **Paced:** strict authentication calls are spaced (about 6.5 s) and a 429 is backed off, never bypassed.
8. **Evidence is preserved:** each check is journalled as it happens; a run that never finished is listed by the next run and never reused or deleted; result files are written once and never overwritten.
9. **Deterministic reports:** checks sorted naturally, stable JSON, a `reportHash` that is identical for identical results.

Environment variables (names only; values are never read into output): `ACCEPTANCE_OWNER_A_EMAIL`, `ACCEPTANCE_OWNER_A_PASSWORD`, `ACCEPTANCE_OWNER_A_BUSINESS_ID`, and the same three with `B`.
Business A needs at least three branches (the harness never creates branches) and business B at least one.

## Readiness preflight

```bash
pnpm --filter @echo-grid-feedback/api acceptance:cashier-02 -- --preflight            # offline: every prerequisite as PASS / BLOCKED / NOT VERIFIED
pnpm --filter @echo-grid-feedback/api acceptance:cashier-02 -- --preflight --online   # also probes the three staging hosts, only if hostnames AND live execution are approved
```

A live run additionally needs `liveExecution.authorized` (separate from the hostname approval). Mailbox adapters: `local-spool` (provider-neutral; one **authenticated** file per recipient in a private `ACCEPTANCE_MAILBOX_SPOOL_DIR`, signed with `ACCEPTANCE_MAILBOX_DELIVERY_KEY`; the delivery boundary writes it with `adapters/local-spool-writer.ts`; a used message is removed). See `CASHIER_AUTH_02E_E2C_ISOLATED_VERIFICATION_MAILBOX.md`. See `docs/architecture/builds/CASHIER/CASHIER_AUTH_02E_E2_MAILBOX_AND_READINESS.md`.

## E2: what was added (and what is still blocked)

| Part | What it is | Evidence |
|---|---|---|
| E2-A `provisioner.ts` | Live customer provisioner: real sign-up only (request link, read it from the approved mailbox, set password, sign in); returning-customer sign-in; no database access, no cleanup | Unit tests with a fake driver. **Never run against a real sign-up.** Needs the three owner approvals below. |
| E2-A `apps/web/e2e/acceptance/signup-driver.ts` | The browser driver that performs those steps on the staging web Worker | Written against the existing customer-email-auth pages; **not exercised** (needs the mailbox). |
| E2-B `verification-mailbox.ts` | Mailbox contract for the email confirmation LINK and the SMS code: one exact synthetic recipient, fresh messages only, link host/path allow-list, no inbox listing, nothing logged | Unit tests with a fixture source. **No live adapter ships.** |
| E2-C `apps/web/e2e/acceptance/cashier-02.spec.ts` | Playwright specs B01 to B09: cashier login, invitation, branch context, customer join and consent, membership state, rejection state, Arabic/RTL, 375 px overflow | **Run for real on a local stack** (local API + web + PostgreSQL): 10/10. Local customers are database fixtures with a locally minted session, so these results are labelled `local` and are never accepted as staging evidence. |
| E2-D `browser-results.ts`, `requires` dependencies, `S15` | Scenario dependencies are explicit and a missing one is always NOT RUN; browser results are ingested only when their recorded mode equals the run's mode | Unit and integration tests |

Three approvals, all recorded in `staging-targets.json` by a reviewed commit, are needed before the live provisioner can run: **staging hostnames** (`approved`), **test mailbox** (`mailbox.approved` with an adapter and approved recipient domains) and **customer provisioning** (`customerProvisioning.approved`). Any one missing keeps every customer scenario NOT RUN.
Phone-verified customers need a real SMS code and stay NOT RUN live (S13).

Running the browser tier locally (see `apps/web/playwright.acceptance.config.ts`):

```bash
# 1. a local API (apps/api: wrangler dev --local, DATABASE via CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) and web (apps/web: CASHIER_DEV_ANY_HOST=1 API_BASE_URL=http://localhost:8787 next dev)
# 2. a FRESH fixture for every run (customers become members during the run), written OUTSIDE the repository
DATABASE_URL=postgres://postgres:postgres@localhost:5432/echogrid_test pnpm --filter @echo-grid-feedback/api exec tsx scripts/acceptance/cashier-02/local-fixture.ts --out /tmp/local-fixture.json
# 3. the specs (E2E_CHROMIUM_PATH is optional: a pre-installed Chromium)
E2E_ACCEPTANCE_MODE=local E2E_LOCAL_FIXTURE=/tmp/local-fixture.json E2E_REPORT_FILE=/tmp/browser-report.json pnpm --filter @echo-grid-feedback/web exec playwright test --config playwright.acceptance.config.ts
```

## Test mailbox (E1 contract; superseded for live use by `verification-mailbox.ts`)

`mailbox.ts` defines the contract and its restrictions (`RestrictedMailbox`): nothing is read without a recorded approval; only synthetic recipients `acc-<runId>-<label>@<approved domain>` of this run; only the sign-up and sign-in purposes; only fresh messages; only a six digit code; the code is returned to the caller and never logged or reported.
No live adapter ships in E1. Without an approved mailbox and a live customer provisioner (E2), every customer-dependent scenario is reported **NOT RUN**, never passed.

## Scenarios

| ID | Area |
|---|---|
| S01 | Cashier authentication and session context |
| S02 | Role restrictions and protected routes |
| S03 | Invitation issue and validation |
| S04 | Customer onboarding and explicit consent |
| S05 | Single-use invitations and replay |
| S06 | Attribution evidence and protected reports |
| S07 | Rejoin attribution |
| S08 | Branch-switch authorization |
| S09 | Cross-business tenant isolation |
| S10 | Purchase idempotency |
| S11 | Redemption concurrency |
| S12 | Expired, revoked and invalid invitations (expiry only with a locally forged token) |
| S13 | Verification requirement for an additional business |
| S14 | Browser tier: NOT RUN unless a browser report of the same mode is supplied with `--browser-results` |
| S15 | Returning customer (E2) |

## How the harness itself is verified

`pnpm test` runs the safety unit tests (`scripts/acceptance/cashier-02/*.test.ts`). `test/integration/cashier-02-acceptance-harness.integration.test.ts` runs all scenarios against the real application and a local PostgreSQL through an in-process client, and proves they discriminate:
five deliberately faulty applications (no consent check, reusable invitation, cross-business report, skipped revocation, unauthorised branch switch) are each caught.
