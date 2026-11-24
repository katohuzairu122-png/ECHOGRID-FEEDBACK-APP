# Customer email authentication (Option A): staging runbook

**Status:** historical preparation procedure, not a current environment inventory. Read-only 2026-11-24 metadata verifies email authentication enabled on API/Web in production and staging, while recovery/legacy-upgrade flags are absent. See [the current activation record](../architecture/builds/CUSTOMER-AUTH/CUSTOMER_AUTH_ACCEPTANCE_AND_ACTIVATION_2026_11_24.md). Do not blindly repeat provisioning, migration or activation steps below. Each mutation requires separate owner authorization; this document grants none.

## Approved policy
- `CUSTOMER_PASSWORD_MIN_LENGTH=8` (owner decision CA-05, final). Applies to customer password creation, and to recovery and
  any customer password-change flow, because all read the same setting. Staff/business-user policies are separate and unchanged.
- Configuration-driven on both Workers; no code default. A missing or invalid value fails closed (503 on the API; the web
  form simply omits the hint and the API still enforces). Existing passwords are not invalidated. Maximum stays 128.
- Approved lifetimes: access 900 s, refresh 2592000 s, absolute 2592000 s.
- Idle limit 30 minutes (`CUSTOMER_SESSION_IDLE_TTL_SECONDS=1800`) and step-up window 5 minutes
  (`CUSTOMER_STEP_UP_WINDOW_SECONDS=300`), approved 2026-11-16. Set in the staging templates; the flag stays `"false"` until the
  secrets exist and activation is separately authorized.

## Required order (do not reorder)
**Staging schema verification -> authorized migration -> code deployment -> feature activation -> acceptance testing**

Why the order is strict: main reads `customers.qr_revocation_epoch` (migration 0078) in every customer query. Deploying code
before 0078/0079 are applied breaks customer routes. The repository journal has 80 migrations (last
`0079_customer_phone_verified_uniqueness`).

## 1. Preflight (read-only)
```bash
git fetch origin main && git rev-parse origin/main
pnpm --filter @echo-grid-feedback/api test -- src/release
# Read-only database readiness (counts and flags only; refuses to run without the guard):
CUSTOMER_EMAIL_AUTH_READINESS=READ_ONLY_CHECK DATABASE_URL="<READ-ONLY staging connection>" \
  pnpm --filter @echo-grid-feedback/api exec tsx scripts/customer-email-auth-readiness.ts
```
Expected before migration: `NOT READY` naming 0078/0079 as missing. Expected after: `READY`, 80/80, and
`credentials, null legacy cutoff : 0`. If that count is above 0, STOP: with rotating mode on those customers' legacy tokens are
denied (lockout). Resolve before activation. Equivalent manual SQL (run in a read-only session):
```sql
SELECT count(*) FROM drizzle.__drizzle_migrations;
SELECT count(*) FROM customer_credentials WHERE legacy_tokens_invalid_before IS NULL;
SELECT count(*) FROM customer_credentials WHERE login_email_verified_at IS NOT NULL;
```
Staging results are **UNKNOWN** until an authorized operator runs this.

## 2. Migration (needs separate authorization)
```bash
pnpm --filter @echo-grid-feedback/api db:check
DATABASE_URL="<staging direct connection>" pnpm --filter @echo-grid-feedback/api db:migrate
# re-run the readiness check; must report READY
```
Rollback: migrations are forward-only; restore from a Neon branch/snapshot taken before step 2.

## 3. Secrets (names only; values are generated and entered by the owner, never committed)
```bash
wrangler secret put CUSTOMER_EMAIL_AUTH_HMAC_SECRET --env staging   # API; >= 32 bytes, dedicated
wrangler secret put CUSTOMER_SESSION_SIGNING_SECRET --env staging   # API; >= 32 bytes, != CUSTOMER_JWT_SECRET
wrangler secret put CLIENT_ATTRIBUTION_SECRET --env staging         # API AND web, identical value
wrangler secret put RESEND_API_KEY --env staging                    # API (existing name, if not already set)
```
Existing and required: `CUSTOMER_JWT_SECRET`, `HYPERDRIVE`, `PASSWORD_HASHER`. These names are intentionally NOT in
`[env.staging.secrets].required`, so a missing one cannot block unrelated staging deploys.

## 4. Deploy with the flag still OFF
The staging templates already set `CUSTOMER_EMAIL_AUTH_ENABLED="false"`, `CUSTOMER_PASSWORD_MIN_LENGTH="8"`, the approved TTLs,
and the staging-only Durable Object binding `CUSTOMER_AUTH_RATE_LIMIT` (class `CustomerEmailRateLimit`, migration tag v2).
```bash
pnpm --filter @echo-grid-feedback/api exec wrangler deploy --dry-run --env staging    # offline validation
# authorized only:
pnpm --filter @echo-grid-feedback/api exec wrangler deploy --env staging
pnpm --filter @echo-grid-feedback/web exec wrangler deploy --env staging
```
Production config is untouched; the Durable Object migration exists only under `[env.staging]`.

## 5. Activation (needs separate authorization; staging only)
Set `CUSTOMER_EMAIL_AUTH_ENABLED="true"` on BOTH staging Workers, only after the idle limit and step-up window are decided and
added. Do not enable in any other environment.

## 6. Acceptance
```bash
E2E_CUSTOMER_EMAIL_AUTH=1 E2E_BASE_URL=<staging web origin> \
  pnpm --filter @echo-grid-feedback/web exec playwright test -c playwright.remote.config.ts e2e/customer-email-auth.spec.ts
```
The confirmation link arrives by email; supply it as `E2E_CUSTOMER_VERIFY_URL` (see the spec header). Phone-verification steps in
staging use the console SMS service, so codes appear in Worker logs, not on a phone. Those steps apply only after the
phone-verification PR (485) is merged.

## 7. Rollback
Set `CUSTOMER_EMAIL_AUTH_ENABLED="false"` on both Workers and redeploy. Legacy customer authentication is unaffected throughout.
Issued rotating sessions stop being honored; password hashes are retained.

## Open owner decisions
Idle limit; step-up window; kill-switch (KS-2); policy for changing a verified phone number; merge of PR 485; provisioning of
secrets and the Durable Object namespace for staging.
