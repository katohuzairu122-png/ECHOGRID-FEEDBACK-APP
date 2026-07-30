# Production Environment Checklist

A condensed, production-specific gate on top of [DEPLOYMENT.md](./DEPLOYMENT.md)
(the full step-by-step runbook). **Production launch is a separate,
explicit approval step, distinct from "release-candidate complete."** Do not
work through this list until the owner has confirmed every item in
[Owner Decisions Required](#owner-decisions-required-before-any-item-below).

## Owner decisions required before any item below

These must be confirmed by the business owner, not chosen by whoever runs
this checklist:

- [ ] Subscription plan names, monthly/annual prices, trial length, usage
      limits, currencies, discount policy, grace-period policy, refund
      policy — see the pricing decision table in the release-candidate report
- [ ] Repository license (currently `UNLICENSED` in `package.json`)
- [ ] Production domain(s) for both Workers
- [ ] Legal: privacy policy, terms of service, data-processing agreement if
      operating in a jurisdiction that requires one (GDPR, CCPA, etc.)
- [ ] Explicit, written launch authorization

## Staging proof required first

- [ ] Every item in [STAGING-CHECKLIST.md](./STAGING-CHECKLIST.md) is
      checked and has been stable for a meaningful soak period, not just
      deployed minutes ago
- [ ] The full Stripe test-mode flow (checkout, webhook, cancellation,
      failed payment, renewal) has been exercised in staging without a
      manual workaround

## Resources (dedicated production instances)

- [ ] Production Neon database — a distinct project from dev/staging, with
      its own backup policy confirmed active (see below)
- [ ] Production Hyperdrive, R2 bucket, KV namespace, queue + DLQ — all
      distinct from staging's, all provisioned per
      [SETUP.md](./SETUP.md#provisioning-cloudflare-resources)
- [ ] Production `ALLOWED_ORIGINS` set to the real production web domain
      only

## Secrets (production/live values — the one environment where these are used)

- [ ] `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` / `CUSTOMER_JWT_SECRET` —
      freshly generated, stored in a password manager, never reused from
      staging
- [ ] `STRIPE_SECRET_KEY` — `sk_live_...`. Confirm the Stripe account is out
      of test mode and the plan Price IDs wired into `/platform/billing/plans`
      are the **live** Price IDs, not test-mode ones carried over from staging
- [ ] `STRIPE_WEBHOOK_SECRET` — from a production-specific webhook endpoint,
      not staging's
- [ ] `TWILIO_*` / `ANTHROPIC_API_KEY` / `RESEND_API_KEY` — real production
      credentials; confirm billing alerts/budget caps are configured on each
      provider's own dashboard before go-live (a bug that loops SMS or LLM
      calls should hit a spend cap, not an unbounded bill)
- [ ] `PLATFORM_ADMIN_PASSWORD` — unique to production, in a password
      manager, ideally with 2FA on the email account behind it

## Security sign-off

- [ ] No unresolved Critical or High findings from the security review (see
      the release-candidate report's Security Findings section)
- [ ] `sk_live_`/`whsec_`/production JWT secrets confirmed absent from: git
      history, CI logs, error-tracking payloads, and the web client bundle

## Operational readiness

- [ ] Structured logging and error monitoring wired up and receiving events
- [ ] Alerting configured for at minimum: 5xx rate, queue DLQ depth, failed
      Stripe webhook deliveries, database connection failures
- [ ] Database backup policy confirmed active on the production Neon project
      (Neon's point-in-time restore, or an explicit export schedule)
- [ ] At least one restore drill performed against a **staging** copy (never
      restore-test against production data)
- [ ] Rollback procedure ([DEPLOYMENT.md](./DEPLOYMENT.md#rollback))
      rehearsed at least once, so the first real rollback isn't also the
      first attempt
- [ ] Incident-response contact/escalation path documented somewhere the
      on-call person can actually find it during an incident

## Deploy

- [ ] `apps/web/wrangler.toml`'s `API_BASE_URL` points at the production API
      Worker's URL/custom domain
- [ ] Follow [DEPLOYMENT.md Steps 1–7](./DEPLOYMENT.md#step-1--provision-cloudflare-resources)
      against production resources/secrets

## Post-deploy validation

- [ ] All of [DEPLOYMENT.md Step 8](./DEPLOYMENT.md#step-8--post-deploy-verification)
- [ ] One real Stripe Checkout with a real card for a nominal amount (or the
      smallest live-mode test the owner is comfortable with), confirmed
      end to end including the webhook-driven subscription sync
- [ ] Confirm the two cron triggers are active in the Cloudflare dashboard
      and that a triggered run doesn't error (check `wrangler tail`)
- [ ] Final manual smoke pass through the actual production URL — not
      staging, not localhost

## Sign-off

Production launch requires explicit, written authorization from the owner
after every item above is checked. This checklist does not grant that
authorization by itself.
