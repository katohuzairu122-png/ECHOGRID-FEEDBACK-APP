# Deployment Runbook

## Purpose & Scope

An ordered, checklist-style path from a freshly cloned repo to a live
production deployment on Cloudflare. [SETUP.md](./SETUP.md) is the
topic-organized reference (every env var, every provisioning command, every
test tier); this document is the **sequence** — what to do, in what order,
and what to verify before moving to the next step. Read this top to bottom
the first time you deploy; use it as a checklist on every deploy after that.

Covers: pre-deploy code verification, Cloudflare resource provisioning,
secrets, Stripe Dashboard setup (not covered elsewhere — Billing is the one
module with configuration that happens outside `wrangler`/this codebase
entirely), database migration, deployment itself, post-deploy verification,
and rollback.

**Current status as of this writing: nothing in this project has been
deployed anywhere.** `node_modules` doesn't exist, no migrations have been
generated, and every Cloudflare resource in `wrangler.toml` is still a
placeholder. Every step below is a real, unstarted step — this is not a
"mostly done, just double-check" list.

## Environments

Cloudflare resources are **not shared** across environments — provision
separately for local dev, staging, and production. A staging environment is
strongly recommended before production, specifically because this module's
Stripe integration has never been exercised end to end (see Step 8): you
want to find a broken webhook handler against Stripe's *test* mode, not
production, with real customers' subscriptions on the line.

## Before You Start: Code Readiness

Do not provision Cloudflare resources against code that has never compiled.
In order:

```bash
pnpm install
pnpm --filter @echo-grid-feedback/api typecheck
pnpm --filter @echo-grid-feedback/web typecheck
cd apps/api && pnpm test              # fake-repo unit tests, no external deps
```

Fix anything these surface before continuing. `pnpm test:integration` and
`pnpm test:workers` need a provisioned database/Cloudflare resources
respectively — come back to those after Step 4.

## Step 1 — Provision Cloudflare Resources

Full commands with explanations: [SETUP.md#provisioning-cloudflare-resources](./SETUP.md#provisioning-cloudflare-resources).
Condensed checklist:

- [ ] `wrangler login` (once per machine, not per environment)
- [ ] `wrangler hyperdrive create` → paste the returned ID into `wrangler.toml`'s `[[hyperdrive]].id`
- [ ] `wrangler r2 bucket create echo-grid-feedback-uploads`
- [ ] `wrangler kv namespace create CACHE` → paste the returned ID into `wrangler.toml`'s `[[kv_namespaces]].id`
- [ ] `wrangler queues create echo-grid-feedback-jobs`
- [ ] `wrangler queues create echo-grid-feedback-jobs-dlq`

R2 buckets and queues are referenced by name in `wrangler.toml` (already
correct) — only Hyperdrive and KV return an ID you have to paste in
manually. The four `[[ratelimits]]` blocks are self-defined labels, not
provisioned resources — leave `namespace_id = "1001"`–`"1004"` as-is.

## Step 2 — Configure Secrets

10 required secrets, validated automatically at `wrangler dev`/`deploy` time
by `wrangler.toml`'s `[secrets].required`. Full list with per-secret notes:
[SETUP.md#environment-variables](./SETUP.md#environment-variables).

```bash
cd apps/api
npx wrangler secret put JWT_ACCESS_SECRET
npx wrangler secret put JWT_REFRESH_SECRET
npx wrangler secret put CUSTOMER_JWT_SECRET
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_FROM_NUMBER
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
```

Generate JWT secret values with `openssl rand -base64 32`. Use a `sk_test_...`
Stripe key for dev/staging, `sk_live_...` only once you're deploying to a
real production environment you intend to charge real cards against.

**Hold off on `STRIPE_WEBHOOK_SECRET`** — its value comes out of Step 3
below, not before it. Also set `ANTHROPIC_MODEL` and `RESEND_FROM_ADDRESS`
in `wrangler.toml`'s `[vars]` (non-secret, but both still have placeholder
values that need a real one — see SETUP.md).

## Step 3 — Stripe Dashboard Setup

The one piece of this module configured entirely outside `wrangler` and this
codebase. Do this in the [Stripe Dashboard](https://dashboard.stripe.com),
in **test mode** first, regardless of which environment you're deploying —
you want to prove the integration works before pointing it at live money.

1. **Create Products and Prices.** For each plan you seeded via
   `pnpm db:seed:plans` (Starter/Growth/Enterprise, or your own catalog),
   create a matching Product with a monthly and yearly Price. Copy each
   Price's ID (`price_...`).
2. **Register the webhook endpoint.** Developers → Webhooks → *Create an
   event destination* → enter `https://<your-api-domain>/webhooks/stripe` as
   the endpoint URL → select `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted` (the
   only three events `StripeWebhookService` handles — see
   [ARCHITECTURE.md](./ARCHITECTURE.md), Component Responsibilities). Stripe
   reveals a signing secret (`whsec_...`) once the endpoint is created — that
   is your `STRIPE_WEBHOOK_SECRET`.
   [Stripe's own current walkthrough](https://docs.stripe.com/development/dashboard/webhooks)
   if the UI has moved since this was written.
3. **Now set the webhook secret:**
   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

**Local dev / testing before you have a public URL**: Stripe webhook
endpoints must be publicly reachable HTTPS URLs — `localhost` cannot be
registered directly. Use the [Stripe CLI](https://stripe.com/docs/stripe-cli)
instead: `stripe listen --forward-to localhost:8787/webhooks/stripe` prints
its own session-scoped `whsec_...` value; use that for local
`STRIPE_WEBHOOK_SECRET` testing (see also
[SETUP.md's Troubleshooting](./SETUP.md#troubleshooting)).

## Step 4 — Database: Migrate & Seed

```bash
cd apps/api
pnpm db:generate               # writes migration SQL from the Drizzle schema
pnpm db:migrate                # applies it to the Neon database behind Hyperdrive
pnpm db:seed                   # permission catalog, including billing:view/:manage
pnpm db:seed:plans             # subscription_plans catalog (placeholder pricing -- see Step 5)
pnpm db:seed:platform-admin    # bootstraps the first /platform login; reads PLATFORM_ADMIN_* from .env
```

`pnpm db:seed:billing-backfill` is **not needed on a fresh deploy** — it
exists only to retroactively grant `billing:view`/`billing:manage` to
businesses that were created *before* the Billing module shipped. Run it
once, only if you're deploying this module against a database that already
has real businesses in it.

## Step 5 — Wire Stripe Price IDs Into the Plan Catalog

The plans seeded in Step 4 have placeholder pricing and no Stripe Price IDs
yet. After deploying (Step 6) and logging in as the platform admin bootstrapped
in Step 4, go to `/platform/billing/plans` and edit each plan: fill in
`Stripe monthly price ID`/`Stripe yearly price ID` with the Price IDs copied
in Step 3.1. Until this is done, `POST /billing/checkout` returns
`PLAN_NOT_PURCHASABLE` for every plan (correctly — this is the intended
guard, not a bug).

## Step 6 — Deploy

API first, then web — the web app calls the API at build/runtime, so
deploying API second would leave web briefly pointed at nothing new.

**Before the web deploy**, set `apps/web/wrangler.toml`'s `[vars].API_BASE_URL`
to the API Worker's real URL (from the `npx wrangler deploy` output below, or
your custom domain) — see [SETUP.md#environment-variables](./SETUP.md#environment-variables).
Left at its `http://localhost:8787` default, the deployed web Worker cannot
reach the API at all.

```bash
# API
cd apps/api
npx wrangler deploy
# note the printed *.workers.dev URL (or your custom domain) --
# apps/web/wrangler.toml's API_BASE_URL must point here

# Web
cd apps/web
pnpm run deploy   # opennextjs-cloudflare build && opennextjs-cloudflare deploy
```

Cloudflare Cron Triggers (`wrangler.toml`'s `[triggers]`) activate
automatically on this deploy — no separate step. Know before you deploy with
`ANTHROPIC_API_KEY` set and `ENVIRONMENT=production`: the cron starts firing
real, billed Anthropic calls for every business on the platform, on
schedule, immediately.

## Step 7 — Update CORS

`ALLOWED_ORIGINS` in `wrangler.toml`'s `[vars]` defaults to
`http://localhost:3000` only. Add your deployed `apps/web` origin(s)
(comma-separated for multiple), then redeploy the API (Step 6, API half
only) — this is a config edit, not an `index.ts` code change. This does not
affect `apps/web`'s own login/dashboard traffic (server-to-server via the
BFF pattern, no CORS involved) — only a hypothetical direct-browser API
consumer would ever hit this.

## Step 8 — Post-Deploy Verification

Go/no-go checklist before calling a deploy done:

- [ ] `GET /health` returns `200`
- [ ] Staff signup/login works end to end through `apps/web`
- [ ] Log into `/platform` with the bootstrapped admin account — confirm the
      3-layer gate passes and the dashboard loads (not the access-denied view)
- [ ] Business directory (`/platform/businesses`) and audit log
      (`/platform/audit-log`) both return data, not empty-forever screens
- [ ] `/dashboard/billing` shows the card-less trial for a newly created business
- [ ] Send a test event from the Stripe Dashboard (Webhooks → your endpoint →
      *Send test webhook*, `customer.subscription.updated`) and confirm it
      shows a `200` response in Stripe's own delivery log — this is the one
      piece of this module that has **never been exercised end to end**
      before your first real deploy
- [ ] Run one real Checkout with a
      [Stripe test card](https://docs.stripe.com/testing) end to end:
      `/dashboard/billing` → pick a plan → complete Checkout → confirm
      `business_subscriptions.status` flips to `active` and the dashboard
      reflects it
- [ ] Confirm the two cron triggers are listed under the Worker's Triggers
      tab in the Cloudflare dashboard

## Continuous Deployment (Optional)

`.github/workflows/ci-cd.yml` automates Step 6 (and only Step 6) once wired
up: on every push/PR it typechecks and runs both apps' fast unit test suites;
on push to `main` (after that check passes) it deploys API then web, in the
same order as the manual commands above. It deliberately does **not** run
Steps 1–5 or 7 — resource provisioning, secrets, Stripe setup, migrations,
and CORS origins all stay manual, deliberate steps, not something a merge to
`main` should trigger silently.

**Two prerequisites this repo does not currently have:**

1. A GitHub remote. This project has no `.git` directory yet — the workflow
   file is inert until you run `git init`, create a GitHub repository, and
   push.
2. Two repository secrets (GitHub repo → Settings → Secrets and variables →
   Actions): `CLOUDFLARE_API_TOKEN` (Cloudflare dashboard → My Profile → API
   Tokens → Create Token → "Edit Cloudflare Workers" template) and
   `CLOUDFLARE_ACCOUNT_ID` (Cloudflare dashboard → Workers & Pages → Account
   ID, right sidebar).

Until both exist, keep deploying with Step 6's manual commands.

## Rollback

```bash
npx wrangler rollback              # rolls back to the previous deployment
npx wrangler rollback <version-id> # or a specific one
npx wrangler deployments list --name echo-grid-feedback-api   # see recent deployments/IDs
```

`wrangler rollback` creates a **new** deployment running the old version's
code — it does not delete history or truly "undo" the bad deploy, and you
can only roll back to one of the most recently published versions.
([Cloudflare's current docs](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)
if this has changed.) **Database migrations do not roll back
automatically** — `pnpm db:migrate` has no down-migration tooling wired up
in this project; a bad migration needs a manual fix or a new forward
migration, not a rollback.

## Promoting Between Environments (dev → staging → production)

Repeat Steps 1–5 for each new environment — resources, secrets, and the
Stripe webhook endpoint are all environment-specific (a staging webhook
endpoint pointed at production, or vice versa, will misdeliver events).
Recommended order: prove the full checklist above against staging with
Stripe test-mode keys before ever setting a `sk_live_...` key anywhere.

## Known Gaps Affecting Production Readiness

Full list with mitigations: [ARCHITECTURE.md#risks--known-gaps](./ARCHITECTURE.md#risks--known-gaps).
Worth reading before a real launch, not just this runbook:

- No abuse-response tooling beyond business suspend/reactivate/archive
- Stripe `apiVersion` pinned in code but never independently confirmed
  against Stripe's current dashboard
- MRR reporting assumes a single currency — no FX conversion
- Suspended/deactivated staff accounts keep a still-valid access token on
  ordinary business routes until it naturally expires (15 min)
- No automated E2E coverage of the Stripe Checkout/webhook flow — Step 8
  above is currently the only verification this module gets before you rely
  on it for real
