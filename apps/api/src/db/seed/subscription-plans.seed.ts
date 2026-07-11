import 'dotenv/config';
import { Client } from 'pg';
import { buildDb } from '../client';
import { SubscriptionPlanRepository, type NewSubscriptionPlan } from '../../repositories/subscription-plan.repository';

/**
 * Starting plan catalog (Billing Block 8). Prices are placeholders --
 * real-world figures were never provided, so these are structurally
 * plausible starting points only, NOT a pricing recommendation; edit
 * before production use, same "flagged estimate" treatment as
 * PUBLIC_RATE_LIMITER's 20/min figure elsewhere in this codebase.
 *
 * stripePriceIdMonthly/Yearly are left null here on purpose -- they can
 * only be real once a Stripe account actually has these Prices created
 * (Stripe Dashboard > Product catalog, or the Stripe CLI/API). Fill them in
 * via a follow-up UPDATE, or the future platform-admin plan editor (Block
 * 10), before checkout can work for a given plan -- billing.service.ts's
 * createCheckoutSession fails loudly (422 PLAN_NOT_PURCHASABLE) rather than
 * silently if a plan is selected before its price IDs are set.
 */
const PLANS: NewSubscriptionPlan[] = [
  {
    key: 'starter',
    name: 'Starter',
    description: 'For a single location getting started with customer feedback.',
    priceMonthlyCents: 2900,
    priceYearlyCents: 29000,
    currency: 'usd',
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    maxBranches: 1,
    maxUsers: 3,
    features: { aiSummaries: false, customBranding: false },
    isActive: true,
    isDefaultTrial: true,
    sortOrder: 0,
  },
  {
    key: 'growth',
    name: 'Growth',
    description: 'For multi-location businesses that need AI-powered insights.',
    priceMonthlyCents: 9900,
    priceYearlyCents: 99000,
    currency: 'usd',
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    maxBranches: 10,
    maxUsers: 25,
    features: { aiSummaries: true, customBranding: false },
    isActive: true,
    isDefaultTrial: false,
    sortOrder: 1,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'Unlimited branches and team members, with custom branding.',
    priceMonthlyCents: 29900,
    priceYearlyCents: 299000,
    currency: 'usd',
    stripePriceIdMonthly: null,
    stripePriceIdYearly: null,
    maxBranches: null,
    maxUsers: null,
    features: { aiSummaries: true, customBranding: true },
    isActive: true,
    isDefaultTrial: false,
    sortOrder: 2,
  },
];

/**
 * Connects directly via DATABASE_URL, same as permissions.seed.ts. Run with:
 *   pnpm --filter @echo-grid-feedback/api db:seed:plans
 */
async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const repo = new SubscriptionPlanRepository(buildDb(client));

  for (const plan of PLANS) {
    await repo.ensure(plan);
    console.log(`Ensured plan: ${plan.key}`);
  }

  await client.end();
}

main().catch((err) => {
  console.error('Subscription plan seed failed:', err);
  process.exit(1);
});
