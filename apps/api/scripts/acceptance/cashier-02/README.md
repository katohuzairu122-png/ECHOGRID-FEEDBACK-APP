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

## Test mailbox (not approved)

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
| S14 | Arabic and RTL interfaces: NOT RUN (browser step, E2) |

## How the harness itself is verified

`pnpm test` runs the safety unit tests (`scripts/acceptance/cashier-02/*.test.ts`). `test/integration/cashier-02-acceptance-harness.integration.test.ts` runs all scenarios against the real application and a local PostgreSQL through an in-process client, and proves they discriminate:
five deliberately faulty applications (no consent check, reusable invitation, cross-business report, skipped revocation, unauthorised branch switch) are each caught.
