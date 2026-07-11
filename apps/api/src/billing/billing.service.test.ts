import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { BillingService } from './billing.service';
import type { SubscriptionPlan } from '../repositories/subscription-plan.repository';
import type {
  BusinessSubscription,
  BusinessSubscriptionWithPlan,
} from '../repositories/business-subscription.repository';

/** Same minimal in-memory fake spirit as branch.service.test.ts -- enough of
 * each repository's interface for BillingService to run against, nothing
 * more. */
function createFakePlanRepo(plans: SubscriptionPlan[]) {
  return {
    async listActive(): Promise<SubscriptionPlan[]> {
      return plans.filter((p) => p.isActive);
    },
    async findById(id: string): Promise<SubscriptionPlan | undefined> {
      return plans.find((p) => p.id === id);
    },
  };
}

function createFakeSubscriptionRepo(subscriptions: BusinessSubscriptionWithPlan[]) {
  return {
    async findByBusiness(businessId: string): Promise<BusinessSubscription | undefined> {
      const sub = subscriptions.find((s) => s.businessId === businessId);
      if (!sub) return undefined;
      const { plan: _plan, ...rest } = sub;
      return rest;
    },
    async findByBusinessWithPlan(businessId: string): Promise<BusinessSubscriptionWithPlan | undefined> {
      return subscriptions.find((s) => s.businessId === businessId);
    },
  };
}

// Derived FROM the real Stripe instance type (Parameters<Stripe[...]...>)
// rather than typed against a guessed Stripe.Checkout.SessionCreateParams
// namespace path -- structurally correct regardless of exactly how
// stripe-node names that nested type.
type CheckoutSessionParams = Parameters<Stripe['checkout']['sessions']['create']>[0];
type PortalSessionParams = Parameters<Stripe['billingPortal']['sessions']['create']>[0];

/** Hand-written fake, not a mocking library -- same no-mock-library
 * convention as every other test in this codebase, applied to the one
 * external SDK client this project injects (billing/stripe-client.ts). Only
 * the two namespaces/methods BillingService actually calls are implemented;
 * the `as unknown as Stripe` cast is deliberate -- the real Stripe type
 * surface is enormous and irrelevant to what's under test here. */
function createFakeStripe(opts: { checkoutUrl?: string | null; portalUrl?: string } = {}) {
  const checkoutCalls: CheckoutSessionParams[] = [];
  const portalCalls: PortalSessionParams[] = [];

  const fake = {
    checkout: {
      sessions: {
        create: async (params: CheckoutSessionParams) => {
          checkoutCalls.push(params);
          return {
            url: opts.checkoutUrl === undefined ? 'https://checkout.stripe.com/session_test' : opts.checkoutUrl,
          };
        },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: PortalSessionParams) => {
          portalCalls.push(params);
          return { url: opts.portalUrl ?? 'https://billing.stripe.com/session_test' };
        },
      },
    },
  };

  return { stripe: fake as unknown as Stripe, checkoutCalls, portalCalls };
}

const NOW = new Date();

const PURCHASABLE_PLAN: SubscriptionPlan = {
  id: 'plan-growth',
  key: 'growth',
  name: 'Growth',
  description: null,
  priceMonthlyCents: 9900,
  priceYearlyCents: 99000,
  currency: 'usd',
  stripePriceIdMonthly: 'price_monthly_growth',
  stripePriceIdYearly: 'price_yearly_growth',
  maxBranches: 5,
  maxUsers: 20,
  features: null,
  isActive: true,
  isDefaultTrial: false,
  sortOrder: 1,
  createdAt: NOW,
  createdBy: null,
  updatedAt: NOW,
  updatedBy: null,
};

/** No yearly price wired up yet -- exercises PLAN_NOT_PURCHASABLE. */
const MONTHLY_ONLY_PLAN: SubscriptionPlan = {
  ...PURCHASABLE_PLAN,
  id: 'plan-starter',
  key: 'starter',
  stripePriceIdYearly: null,
};

const INACTIVE_PLAN: SubscriptionPlan = {
  ...PURCHASABLE_PLAN,
  id: 'plan-legacy',
  key: 'legacy',
  isActive: false,
};

function makeSubscription(overrides: Partial<BusinessSubscriptionWithPlan> = {}): BusinessSubscriptionWithPlan {
  return {
    id: 'sub-1',
    businessId: 'business-1',
    planId: PURCHASABLE_PLAN.id,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    status: 'trialing',
    billingInterval: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEndsAt: NOW,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    createdAt: NOW,
    createdBy: null,
    updatedAt: NOW,
    updatedBy: null,
    plan: PURCHASABLE_PLAN,
    ...overrides,
  };
}

describe('BillingService', () => {
  describe('listPlans', () => {
    it('strips Stripe price IDs from every plan', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        { subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]), businessSubscriptions: createFakeSubscriptionRepo([]) },
        stripe,
      );

      const [plan] = await service.listPlans();
      expect(plan).not.toHaveProperty('stripePriceIdMonthly');
      expect(plan).not.toHaveProperty('stripePriceIdYearly');
      expect(plan.id).toBe(PURCHASABLE_PLAN.id);
    });

    it('excludes inactive (retired) plans -- the picker only offers what is currently purchasable', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN, INACTIVE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([]),
        },
        stripe,
      );

      const plans = await service.listPlans();
      expect(plans).toHaveLength(1);
      expect(plans[0].id).toBe(PURCHASABLE_PLAN.id);
    });
  });

  describe('getSubscription', () => {
    it('returns undefined for a business with no subscription row', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        { subscriptionPlans: createFakePlanRepo([]), businessSubscriptions: createFakeSubscriptionRepo([]) },
        stripe,
      );

      await expect(service.getSubscription('business-none')).resolves.toBeUndefined();
    });

    it('strips Stripe identifiers from both the subscription and the nested plan', async () => {
      const { stripe } = createFakeStripe();
      const subscription = makeSubscription({
        stripeCustomerId: 'cus_123',
        stripeSubscriptionId: 'sub_123',
        status: 'active',
      });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([subscription]),
        },
        stripe,
      );

      const view = await service.getSubscription('business-1');
      expect(view).not.toHaveProperty('stripeCustomerId');
      expect(view).not.toHaveProperty('stripeSubscriptionId');
      expect(view?.plan).not.toHaveProperty('stripePriceIdMonthly');
      expect(view?.plan).not.toHaveProperty('stripePriceIdYearly');
      expect(view?.status).toBe('active');
    });

    it('hasPaymentAccount is true once a Stripe customer exists', async () => {
      const { stripe } = createFakeStripe();
      const subscription = makeSubscription({ stripeCustomerId: 'cus_123' });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([subscription]),
        },
        stripe,
      );

      const view = await service.getSubscription('business-1');
      expect(view?.hasPaymentAccount).toBe(true);
    });

    it('hasPaymentAccount is false for a card-less trial', async () => {
      const { stripe } = createFakeStripe();
      const subscription = makeSubscription({ stripeCustomerId: null });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([subscription]),
        },
        stripe,
      );

      const view = await service.getSubscription('business-1');
      expect(view?.hasPaymentAccount).toBe(false);
    });
  });

  describe('createCheckoutSession', () => {
    const INPUT = {
      planId: PURCHASABLE_PLAN.id,
      interval: 'month' as const,
      successUrl: 'https://app.example.com/billing?success=1',
      cancelUrl: 'https://app.example.com/billing?canceled=1',
    };

    it('throws PLAN_NOT_FOUND for an unknown plan id', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        { subscriptionPlans: createFakePlanRepo([]), businessSubscriptions: createFakeSubscriptionRepo([]) },
        stripe,
      );

      await expect(
        service.createCheckoutSession('business-1', 'owner@example.com', INPUT),
      ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND', status: 404 });
    });

    it('throws PLAN_NOT_FOUND for a retired (inactive) plan', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        { subscriptionPlans: createFakePlanRepo([INACTIVE_PLAN]), businessSubscriptions: createFakeSubscriptionRepo([]) },
        stripe,
      );

      await expect(
        service.createCheckoutSession('business-1', 'owner@example.com', { ...INPUT, planId: INACTIVE_PLAN.id }),
      ).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND', status: 404 });
    });

    it('throws PLAN_NOT_PURCHASABLE when the requested interval has no Stripe price configured', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([MONTHLY_ONLY_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([]),
        },
        stripe,
      );

      await expect(
        service.createCheckoutSession('business-1', 'owner@example.com', {
          ...INPUT,
          planId: MONTHLY_ONLY_PLAN.id,
          interval: 'year',
        }),
      ).rejects.toMatchObject({ code: 'PLAN_NOT_PURCHASABLE', status: 422 });
    });

    it('uses customer_email for a business with no existing Stripe customer, and stamps businessId/planId into subscription_data.metadata', async () => {
      const { stripe, checkoutCalls } = createFakeStripe();
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([]),
        },
        stripe,
      );

      await service.createCheckoutSession('business-1', 'owner@example.com', INPUT);

      expect(checkoutCalls[0].customer_email).toBe('owner@example.com');
      expect(checkoutCalls[0].customer).toBeUndefined();
      expect(checkoutCalls[0].subscription_data?.metadata).toMatchObject({
        businessId: 'business-1',
        planId: PURCHASABLE_PLAN.id,
      });
    });

    it("reuses the business's existing Stripe customer instead of customer_email", async () => {
      const { stripe, checkoutCalls } = createFakeStripe();
      const subscription = makeSubscription({ stripeCustomerId: 'cus_existing' });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([subscription]),
        },
        stripe,
      );

      await service.createCheckoutSession('business-1', 'owner@example.com', INPUT);

      expect(checkoutCalls[0].customer).toBe('cus_existing');
      expect(checkoutCalls[0].customer_email).toBeUndefined();
    });

    it('selects the yearly Stripe price when interval is year', async () => {
      const { stripe, checkoutCalls } = createFakeStripe();
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([]),
        },
        stripe,
      );

      await service.createCheckoutSession('business-1', 'owner@example.com', { ...INPUT, interval: 'year' });

      expect(checkoutCalls[0].line_items?.[0]).toMatchObject({ price: PURCHASABLE_PLAN.stripePriceIdYearly });
    });

    it('throws STRIPE_SESSION_ERROR if Stripe returns no checkout URL', async () => {
      const { stripe } = createFakeStripe({ checkoutUrl: null });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([]),
        },
        stripe,
      );

      await expect(
        service.createCheckoutSession('business-1', 'owner@example.com', INPUT),
      ).rejects.toMatchObject({ code: 'STRIPE_SESSION_ERROR', status: 500 });
    });

    it('returns the Stripe-hosted checkout URL on success', async () => {
      const { stripe } = createFakeStripe({ checkoutUrl: 'https://checkout.stripe.com/abc' });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([]),
        },
        stripe,
      );

      await expect(service.createCheckoutSession('business-1', 'owner@example.com', INPUT)).resolves.toEqual({
        url: 'https://checkout.stripe.com/abc',
      });
    });
  });

  describe('createPortalSession', () => {
    const INPUT = { returnUrl: 'https://app.example.com/dashboard/billing' };

    it('throws NO_STRIPE_CUSTOMER for a business that has never completed checkout', async () => {
      const { stripe } = createFakeStripe();
      const subscription = makeSubscription({ stripeCustomerId: null });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([subscription]),
        },
        stripe,
      );

      await expect(service.createPortalSession('business-1', INPUT)).rejects.toMatchObject({
        code: 'NO_STRIPE_CUSTOMER',
        status: 422,
      });
    });

    it('throws NO_STRIPE_CUSTOMER for a business with no subscription row at all', async () => {
      const { stripe } = createFakeStripe();
      const service = new BillingService(
        { subscriptionPlans: createFakePlanRepo([]), businessSubscriptions: createFakeSubscriptionRepo([]) },
        stripe,
      );

      await expect(service.createPortalSession('business-none', INPUT)).rejects.toMatchObject({
        code: 'NO_STRIPE_CUSTOMER',
      });
    });

    it("opens a portal session for the business's existing Stripe customer", async () => {
      const { stripe, portalCalls } = createFakeStripe({ portalUrl: 'https://billing.stripe.com/xyz' });
      const subscription = makeSubscription({ stripeCustomerId: 'cus_existing' });
      const service = new BillingService(
        {
          subscriptionPlans: createFakePlanRepo([PURCHASABLE_PLAN]),
          businessSubscriptions: createFakeSubscriptionRepo([subscription]),
        },
        stripe,
      );

      await expect(service.createPortalSession('business-1', INPUT)).resolves.toEqual({
        url: 'https://billing.stripe.com/xyz',
      });
      expect(portalCalls[0]).toMatchObject({ customer: 'cus_existing', return_url: INPUT.returnUrl });
    });
  });
});
