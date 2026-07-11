# Setup Guide

Canonical setup, provisioning, and deployment reference. `README.md` has a
5-line quick start for people who just want it running locally; this document
covers the rest — first-time Cloudflare provisioning, every environment
variable, database migrations, testing, and deployment.

## Prerequisites

- Node.js >= 22
- pnpm >= 11 (`corepack enable` installs the version pinned in `package.json`
  automatically)
- A Cloudflare account, with `npx wrangler login` run at least once (only
  required for provisioning/deploying, not for local dev against already-
  configured bindings)
- A [Neon](https://neon.tech) Postgres project and its connection string

## Install

```bash
git clone <repo-url>
cd "feedback flow app"
pnpm install
```

This installs dependencies for both `apps/api` and `apps/web` via the pnpm
workspace defined in `pnpm-workspace.yaml`.

## Provisioning Cloudflare Resources

One-time, per environment (do this once for local dev, again for staging,
again for production — Cloudflare resources aren't shared across
environments by default). Run from `apps/api`:

```bash
cd apps/api

# Hyperdrive -- accelerates and pools connections to your Neon database
npx wrangler hyperdrive create echo-grid-feedback-db \
  --connection-string="postgresql://<user>:<password>@<neon-host>/<db>?sslmode=require"

# R2 bucket -- receipts, exports, and other business-uploaded files (NOT QR
# images -- those render client-side from a token + URL, see ARCHITECTURE.md)
npx wrangler r2 bucket create echo-grid-feedback-uploads

# KV namespace -- cache / session support
npx wrangler kv namespace create CACHE

# Queue -- async jobs (sentiment analysis, notifications, loyalty recalculation)
npx wrangler queues create echo-grid-feedback-jobs

# Dead-letter queue -- receives a message after 3 failed processing attempts
# (wrangler.toml's [[queues.consumers]] max_retries). Classification failures
# already degrade gracefully to analysisStatus='failed' on the row itself, so
# this exists for visibility into systemic failures (e.g. a Workers AI
# outage), not as the primary error path.
npx wrangler queues create echo-grid-feedback-jobs-dlq

# Secrets -- never stored in wrangler.toml or git
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET

# Digital Loyalty module -- customer sessions use a separate JWT secret from
# staff, so a leak of one token system never compromises the other.
npx wrangler secret put CUSTOMER_JWT_SECRET

# Twilio (SMS OTP delivery). Only used when ENVIRONMENT=production --
# ConsoleSmsService logs the code instead in dev/staging, so these can be
# any placeholder value locally.
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER

# Anthropic (AI Sentiment Analytics module -- period summary generation).
# Only used when ENVIRONMENT=production -- ConsoleSummaryGenerator
# substitutes instead in dev/staging, so this can be any placeholder value
# locally. Also set ANTHROPIC_MODEL in wrangler.toml's [vars] (not a secret --
# it's a model identifier, not a credential); confirm the current valid model
# string in Anthropic's docs (docs.claude.com) before deploying.
npx wrangler secret put ANTHROPIC_API_KEY

# Resend (Notifications module -- transactional email delivery). Only used
# when ENVIRONMENT=production -- ConsoleEmailService substitutes instead in
# dev/staging, so this can be any placeholder value locally. Also set
# RESEND_FROM_ADDRESS in wrangler.toml's [vars] to a sender/domain verified
# in the same Resend account, or production sends will fail.
npx wrangler secret put RESEND_API_KEY

# Stripe (Platform Admin Console Billing module). STRIPE_SECRET_KEY is a
# sk_test_... key locally, sk_live_... in production -- there is no
# Console-style dev fallback for Stripe (see config/env.ts's Bindings
# comment), since Checkout/Portal are real hosted-page redirects with no
# meaningful way to fake one. STRIPE_WEBHOOK_SECRET is a *different* value
# per endpoint you register in the Stripe Dashboard (or per `stripe listen`
# session locally) -- see docs/DEPLOYMENT.md for the full Stripe Dashboard
# setup sequence (products/prices, webhook registration) this command alone
# doesn't cover.
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
```

Cloudflare Cron Triggers (`wrangler.toml`'s `[triggers]`, weekly + monthly
automatic summary generation) need no separate provisioning command -- they
deploy automatically with `wrangler deploy` once declared. Worth knowing
before your first deploy to a real environment: with `ANTHROPIC_API_KEY` set
and `ENVIRONMENT=production`, the cron starts firing real, paid Anthropic API
calls for every business on the platform, on schedule, with no manual trigger
required.

Each `create` command prints an ID. Paste them into the placeholder fields in
`apps/api/wrangler.toml`:

| Placeholder in `wrangler.toml` | Replace with |
| --- | --- |
| `[[hyperdrive]].id` | ID from `wrangler hyperdrive create` |
| `[[kv_namespaces]].id` | ID from `wrangler kv namespace create` |

R2 buckets and queues are referenced by name (already set correctly); no ID
substitution needed for those two. The four `[[ratelimits]]` blocks
(`namespace_id = "1001"` / `"1002"` / `"1003"` / `"1004"`, the third added in
QR Engagement Block 2 for the public QR/feedback surface, the fourth in
Digital Loyalty Block 2 for SMS OTP requests — 3/min/IP, the platform's
strictest limiter, since each request costs real Twilio money) are **not**
Cloudflare-provisioned IDs — they're arbitrary account-unique labels you
define yourself in the config; the placeholders already in `wrangler.toml`
are valid as-is and don't need replacing.

Generate strong secret values with `openssl rand -base64 32`.

## Environment Variables

Two separate concerns, two separate files — do not mix them up:

**`apps/api/.dev.vars`** (copy from `.dev.vars.example`, gitignored) — the
Worker's runtime secrets for local dev. Mirrors what `wrangler secret put`
sets in deployed environments.

```
JWT_ACCESS_SECRET=<openssl rand -base64 32>
JWT_REFRESH_SECRET=<a different value>
CUSTOMER_JWT_SECRET=<a third different value>
TWILIO_ACCOUNT_SID=<any placeholder locally -- unused outside production>
TWILIO_AUTH_TOKEN=<any placeholder locally>
TWILIO_FROM_NUMBER=+15550000000
ANTHROPIC_API_KEY=<any placeholder locally -- unused outside production>
RESEND_API_KEY=<any placeholder locally -- unused outside production>
STRIPE_SECRET_KEY=<sk_test_... from the Stripe Dashboard, Developers > API keys>
STRIPE_WEBHOOK_SECRET=<whsec_... from Developers > Webhooks > your endpoint>
```

`STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` back Platform Admin Console
Billing (Block 8) — `apps/api/src/billing/stripe-client.ts` and
`stripe-webhook.routes.ts`. See Troubleshooting below for testing the
webhook locally.

**`apps/api/.env`** (copy from `.env.example`, gitignored) — used *only* by
`drizzle-kit` and the seed scripts, all of which run as plain Node CLIs
outside the Workers runtime and can't use the Hyperdrive binding.

```
DATABASE_URL=postgresql://<user>:<password>@<neon-host>/<db>?sslmode=require

# Platform Admin Console -- bootstraps the first account that can log into
# /platform (db:seed:platform-admin, see Database below). Use a real,
# strong password even in staging -- this account can access every
# business's data.
PLATFORM_ADMIN_EMAIL=admin@yourcompany.example
PLATFORM_ADMIN_PASSWORD=replace-with-a-strong-random-value
PLATFORM_ADMIN_NAME=Platform Admin
```

Point `DATABASE_URL` at the same Neon database as the Hyperdrive connection
string above.

**`apps/web/.env.local`** (copy from `apps/web/.env.example`) — server-only
config for the web app. Deliberately **not** `NEXT_PUBLIC_`-prefixed: under
the BFF pattern introduced in Branch Mgmt Block 3, the browser never calls
`apps/api` directly, so only the Next.js server needs this value. It was
originally `NEXT_PUBLIC_API_BASE_URL` before that pattern existed; renamed
in Block 4 once keeping the public prefix would have shipped the API's URL
into client JS for no reason.

```
API_BASE_URL=http://localhost:8787
```

No separate variable exists for the web app's own public URL (e.g. for
building the customer-facing `/feedback/:token` link shown in the QR code
dialog) — it's read from `window.location.origin` at render time instead,
since the dashboard and the public landing page are the same Next.js
deployment. See ARCHITECTURE.md's QR Engagement section if a future change
ever needs that URL server-side instead.

## Database

```bash
cd apps/api
pnpm db:generate              # writes SQL migration files to apps/api/drizzle/
pnpm db:migrate               # applies them to your Neon database
pnpm db:seed                  # seeds the platform permission catalog (re-run after adding new keys)
pnpm db:seed:platform-admin   # bootstraps the first /platform login (reads PLATFORM_ADMIN_* from .env)
pnpm db:seed:plans            # seeds the starter subscription plan catalog (Starter/Growth/Enterprise)
pnpm db:seed:billing-backfill # one-time: grants billing:view/:manage to existing businesses' Owner/Admin roles
pnpm db:studio                # optional: visual browser for the schema
```

All seed scripts are idempotent — safe to run repeatedly, including on every
deploy. `db:seed:billing-backfill` specifically exists because
`RoleProvisioningService`'s `DEFAULT_ROLES` only grants the two new billing
permissions to roles seeded *going forward*; run it once per environment
after migrating to backfill businesses that already existed before Billing
shipped.

## Running Locally

```bash
pnpm dev:api   # http://localhost:8787  (GET /health should return 200)
pnpm dev:web   # http://localhost:3000
```

Run both in separate terminals. `apps/web` never imports API code directly,
and — since Branch Mgmt Block 3's BFF pattern — the *browser* never calls
`apps/api` either; only `apps/web`'s own server does, over plain HTTP via
`API_BASE_URL`, from Server Actions and Server Components.

## Testing

Backend (`apps/api`):

```bash
cd apps/api
pnpm test               # default -- plain Node, no external deps required
pnpm test:integration   # needs DATABASE_URL pointed at a real (scratch/dev) Postgres
pnpm test:workers       # needs real wrangler.toml binding IDs, not placeholders
```

Frontend (`apps/web`), added in Branch Mgmt Block 6:

```bash
cd apps/web
pnpm test        # Vitest + React Testing Library -- Client Components and pure functions only
pnpm test:e2e     # Playwright -- needs both dev servers running (playwright.config.ts
                  # starts them for you) and a real database with migrations + pnpm db:seed applied
```

Full explanation of what each tier covers, and why the split falls where it
does, is in the root `README.md`'s Testing sections. Run `pnpm test` (in
whichever app you're changing) first — it's the tier guaranteed not to need
any external setup, in both apps.

## Deployment

```bash
# API
cd apps/api
npx wrangler deploy

# Web
cd apps/web
pnpm run deploy   # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

Before the first production deploy of `apps/web`, add its real origin to the
CORS allow-list in `apps/api/src/index.ts` (currently `http://localhost:3000`
only) — see [ARCHITECTURE.md](./ARCHITECTURE.md#risks--known-gaps).

**First deploy, or need the full ordered sequence (Cloudflare provisioning →
Stripe Dashboard setup → migrations → deploy → go-live checks → rollback)?**
Use [DEPLOYMENT.md](./DEPLOYMENT.md) instead — this section is a reminder for
people who've already deployed before, not a first-time walkthrough.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `wrangler dev` fails immediately citing missing secrets | `[secrets].required` in `wrangler.toml` validates `JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET` exist before starting | Create `apps/api/.dev.vars` from the example file |
| Hyperdrive connection errors in dev | Placeholder `id` still in `wrangler.toml`, or Neon connection string is wrong/expired | Re-run `wrangler hyperdrive create` and update the ID |
| `db:generate`/`db:migrate`/`db:seed` can't connect | `apps/api/.env` missing or `DATABASE_URL` wrong | These read `.env` directly, not `.dev.vars` — confirm the file exists and the string is correct |
| `pnpm test:workers` fails to start the simulated runtime | Placeholder Hyperdrive/R2/KV IDs in `wrangler.toml` | Provision real resources first (see above); only bindings-free test paths pass against placeholders |
| Browser requests to the API are blocked by CORS | Origin not in the allow-list in `apps/api/src/index.ts` | Add it — see the Deployment note above. Not relevant to the web app's own auth/data calls, which go through the BFF server-to-server, not the browser — only a hypothetical separate direct-browser consumer would hit this |
| `apps/web`'s `pnpm test:e2e` hangs or times out waiting for a server | `playwright.config.ts`'s `webServer` starts `pnpm dev` in both apps but does not run migrations or seed data | Provision + migrate + `pnpm db:seed` first (see Database above), and confirm `apps/api/.dev.vars` exists so `pnpm dev:api` doesn't fail on missing secrets |
| Never received an SMS after `POST /customer-auth/otp/request` in local dev | Expected — `ConsoleSmsService` is used whenever `ENVIRONMENT !== 'production'` | Check `apps/api`'s `wrangler dev` terminal output for a `[ConsoleSmsService] would send to ...` log line containing the code |
| `429 OTP_COOLDOWN` immediately on a second manual OTP test | Working as designed — one request per phone per 60 seconds | Wait 60 seconds, or use a different test phone number |
| `403 PLATFORM_ACCESS_DENIED` on every `/platform/*` route, or the `/platform` UI shows "Platform admin access required" | No account with a non-null `platformRole` exists yet, or you're logged in as one that doesn't have one | Run `pnpm db:seed:platform-admin` (see Database above), then log in as `PLATFORM_ADMIN_EMAIL` |
| Stripe webhook events never reach `POST /webhooks/stripe` in local dev | Stripe can't call `localhost` directly | Install the [Stripe CLI](https://stripe.com/docs/stripe-cli) and run `stripe listen --forward-to localhost:8787/webhooks/stripe`; it prints a `whsec_...` value — use that as `STRIPE_WEBHOOK_SECRET` in `.dev.vars` for local testing (a different value than your deployed endpoint's signing secret) |
| `POST /billing/checkout`/`/portal` return `PLAN_NOT_PURCHASABLE` or a Stripe error | The seeded plans (`db:seed:plans`) have placeholder pricing and no real `stripePriceIdMonthly`/`Yearly` | Create matching Prices in your Stripe test-mode Dashboard, then set them via `PATCH /platform/billing/plans/:id` (or the `/platform/billing/plans` UI) before testing checkout end to end |
