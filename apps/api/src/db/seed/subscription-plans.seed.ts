import 'dotenv/config';
import { Client } from 'pg';
import { buildDb } from '../client';
import {
  SubscriptionPlanRepository,
  type NewSubscriptionPlan,
} from '../../repositories/subscription-plan.repository';

/**
 * Affordable launch catalog. Response allowances live in the open features
 * object so the entitlement layer and plan UI share the same plan-owned value.
 * Stripe Price IDs are intentionally omitted: seeding must never overwrite
 * production IDs after an operator connects the matching Stripe prices.
 */
const PLANS: NewSubscriptionPlan[] = [
  {
    key: 'free',
    name: 'Free',
    description: 'Explore Echo Grid with a small monthly feedback allowance.',
    priceMonthlyCents: 0,
    priceYearlyCents: null,
    currency: 'usd',
    maxBranches: 1,
    maxUsers: 1,
    features: { monthlyResponses: 25, aiSummaries: false, customBranding: false },
    isActive: true,
    isDefaultTrial: false,
    sortOrder: 0,
  },
  {
    key: 'starter',
    name: 'Starter',
    description: 'For one location ready to collect feedback every day.',
    priceMonthlyCents: 900,
    priceYearlyCents: 9000,
    currency: 'usd',
    maxBranches: 1,
    maxUsers: 3,
    features: { monthlyResponses: 1000, aiSummaries: false, customBranding: false },
    isActive: true,
    isDefaultTrial: true,
    sortOrder: 1,
  },
  {
    key: 'growth',
    name: 'Growth',
    description: 'For growing teams managing feedback across several locations.',
    priceMonthlyCents: 2900,
    priceYearlyCents: 29000,
    currency: 'usd',
    maxBranches: 5,
    maxUsers: 10,
    features: { monthlyResponses: 5000, aiSummaries: true, customBranding: false },
    isActive: true,
    isDefaultTrial: false,
    sortOrder: 2,
  },
  {
    key: 'business',
    name: 'Business',
    description:
      'For established multi-location teams that need higher limits and AI insights.',
    priceMonthlyCents: 5900,
    priceYearlyCents: 59000,
    currency: 'usd',
    maxBranches: 15,
    maxUsers: 30,
    features: { monthlyResponses: 20000, aiSummaries: true, customBranding: true },
    isActive: true,
    isDefaultTrial: false,
    sortOrder: 3,
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    description: 'Custom limits, onboarding, and support for large organizations.',
    priceMonthlyCents: 0,
    priceYearlyCents: null,
    currency: 'usd',
    maxBranches: null,
    maxUsers: null,
    features: { monthlyResponses: null, aiSummaries: true, customBranding: true },
    isActive: true,
    isDefaultTrial: false,
    sortOrder: 4,
  },
];

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
