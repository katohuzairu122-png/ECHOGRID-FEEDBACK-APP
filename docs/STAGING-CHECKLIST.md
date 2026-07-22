# Staging Environment Checklist

A condensed, staging-specific gate on top of [DEPLOYMENT.md](./DEPLOYMENT.md)
(the full step-by-step runbook — read that first). This file is the
short "did I actually do everything staging needs" pass before calling a
staging deploy done. Full variable reference:
[SETUP.md#environment-variables](./SETUP.md#environment-variables).

## Before you start

- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass on the
      commit being deployed (see the repo root scripts)
- [ ] A **dedicated staging Neon project/branch** exists — never point
      staging at the same database as production or another developer's
      local scratch DB

## Resources (staging-specific instances — do not reuse dev's or production's)

- [ ] Staging Neon database created; `DATABASE_URL` captured
- [ ] `wrangler hyperdrive create` run against the staging `DATABASE_URL`;
      ID pasted into a staging copy of `apps/api/wrangler.toml`
- [ ] Staging R2 bucket created (a distinct bucket name, e.g.
      `echo-grid-feedback-uploads-staging`)
- [ ] Staging KV namespace created; ID pasted in
- [ ] Staging queue + DLQ created (distinct names, e.g. `-staging` suffix)
- [ ] Staging `ALLOWED_ORIGINS` set to the staging web Worker's own origin —
      never include a production origin here

## Secrets (staging values — never production/live values)

- [ ] `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `CUSTOMER_JWT_SECRET` —
      freshly generated for staging, not copied from dev or production
- [ ] `STRIPE_SECRET_KEY` — **`sk_test_...` only.** Staging must never hold a
      live Stripe key.
- [ ] `STRIPE_WEBHOOK_SECRET` — from a staging-specific webhook endpoint in
      the Stripe Dashboard (test mode), pointed at the staging API URL —
      not the same endpoint/secret as production
- [ ] Twilio / Anthropic / Resend keys — real keys are fine here (staging is
      allowed to actually send SMS/emails/AI calls), but confirm you're
      comfortable with the real cost/volume before enabling
- [ ] `PLATFORM_ADMIN_PASSWORD` — a real generated value, not a placeholder,
      even though this is "only" staging — it has full cross-tenant access

## Deploy

- [ ] `apps/web/wrangler.toml`'s `API_BASE_URL` points at the staging API
      Worker's URL (not `localhost`, not production's URL)
- [ ] Follow [DEPLOYMENT.md Steps 1–7](./DEPLOYMENT.md#step-1--provision-cloudflare-resources)
      against the staging resources/secrets above

## Post-deploy validation (staging's actual purpose)

- [ ] All of [DEPLOYMENT.md Step 8](./DEPLOYMENT.md#step-8--post-deploy-verification)
- [ ] A full Stripe **test-mode** Checkout → webhook → `business_subscriptions`
      sync round trip, end to end
- [ ] Playwright E2E suite run against the staging URL (not just localhost)
- [ ] Confirm no secrets appear in `apps/web`'s client bundle (`view-source:`
      or `wrangler tail` the deployed Worker and grep for key prefixes like
      `sk_`, `whsec_`, `re_`)
- [ ] Confirm cross-tenant isolation manually: two test businesses, confirm
      neither can see the other's branches/feedback/loyalty data

## Sign-off

Staging is not "done" until every box above is checked **and** the
[Definition of Done](../README.md) gates for a release candidate all pass
against this staging deployment specifically — a green `main` branch is not
the same claim as a green staging environment.
