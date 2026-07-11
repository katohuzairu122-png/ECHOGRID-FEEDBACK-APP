import type Stripe from 'stripe';
import type { Repositories } from '../repositories';
import type { SubscriptionPlan, BusinessSubscriptionWithPlan } from '../repositories';
import type { CreateCheckoutSessionInput, CreatePortalSessionInput } from '@echo-grid-feedback/shared-types';
import { AppError } from '../lib/errors';

/** getSubscription()'s return shape -- the repository row with Stripe
 * identifiers swapped for the one derived boolean the frontend needs. See
 * getSubscription's own doc comment for why this gets stricter treatment
 * than most repository-to-response passthroughs in this codebase. */
type BillingSubscriptionView = Omit<
  BusinessSubscriptionWithPlan,
  'stripeCustomerId' | 'stripeSubscriptionId' | 'plan'
> & {
  hasPaymentAccount: boolean;
  plan: Omit<SubscriptionPlan, 'stripePriceIdMonthly' | 'stripePriceIdYearly'>;
};

/**
 * Business-facing billing operations: list plans, read the current
 * subscription, and hand off to Stripe-hosted pages for anything that
 * touches a payment method (Checkout for a new/changed subscription,
 * Customer Portal for everything after). This service never handles a card
 * number or builds its own payment UI -- Stripe Checkout/Portal keep that
 * entirely out of this codebase's PCI scope, the same reasoning that
 * already led every other integration in this project toward hosted/managed
 * surfaces over custom ones where one exists.
 */
export class BillingService {
  constructor(
    private readonly repos: Pick<Repositories, 'subscriptionPlans' | 'businessSubscriptions'>,
    private readonly stripe: Stripe,
  ) {}

  /** Strips stripePriceIdMonthly/Yearly -- same reasoning as
   * getSubscription's own strip, applied to the plan picker's list view. */
  async listPlans(): Promise<Omit<SubscriptionPlan, 'stripePriceIdMonthly' | 'stripePriceIdYearly'>[]> {
    const plans = await this.repos.subscriptionPlans.listActive();
    return plans.map(({ stripePriceIdMonthly, stripePriceIdYearly, ...rest }) => rest);
  }

  /**
   * Returns undefined for a business with no subscription row -- a real, if
   * increasingly rare, state (e.g. a business that predates Billing Block 8
   * and hasn't been backfilled). The route surfaces this as `data: null`,
   * not a 404 -- "no subscription yet" is a legitimate response, not an
   * error.
   *
   * Strips stripeCustomerId/stripeSubscriptionId/stripePriceId* before
   * returning -- unlike most internal fields elsewhere in this codebase
   * (audit columns, isDeleted, ... which this project tolerates leaking
   * into API responses, see e.g. BranchService returning raw repository
   * rows), live external-payment-processor identifiers get the stricter
   * treatment: least-privilege, and there is no legitimate frontend use for
   * them. hasPaymentAccount replaces stripeCustomerId with the one boolean
   * fact the UI actually needs (can "Manage billing" be opened yet).
   */
  async getSubscription(businessId: string): Promise<BillingSubscriptionView | undefined> {
    const subscription = await this.repos.businessSubscriptions.findByBusinessWithPlan(businessId);
    if (!subscription) return undefined;

    const { stripeCustomerId, stripeSubscriptionId, plan, ...subscriptionRest } = subscription;
    const { stripePriceIdMonthly, stripePriceIdYearly, ...planRest } = plan;

    return {
      ...subscriptionRest,
      hasPaymentAccount: Boolean(stripeCustomerId),
      plan: planRest,
    };
  }

  /**
   * Creates a Stripe Checkout Session for a new or plan-changing
   * subscription. `subscription_data.metadata.businessId` is the load-bearing
   * piece here -- Stripe propagates Checkout Session subscription_data
   * metadata onto the real Subscription object it creates, so every future
   * webhook event about this subscription (customer.subscription.updated/
   * deleted) carries businessId directly, with no separate customer-ID
   * lookup table needed to resolve "whose subscription is this."
   *
   * Reuses the business's existing Stripe Customer (if this isn't its first
   * checkout) rather than letting Stripe mint a new one each time, so a
   * business's payment history stays under one Stripe Customer record.
   */
  async createCheckoutSession(
    businessId: string,
    userEmail: string,
    input: CreateCheckoutSessionInput,
  ): Promise<{ url: string }> {
    const plan = await this.repos.subscriptionPlans.findById(input.planId);
    if (!plan || !plan.isActive) {
      throw new AppError('Plan not found.', 404, 'PLAN_NOT_FOUND');
    }

    const priceId = input.interval === 'month' ? plan.stripePriceIdMonthly : plan.stripePriceIdYearly;
    if (!priceId) {
      throw new AppError(
        `This plan has no ${input.interval}ly price configured yet.`,
        422,
        'PLAN_NOT_PURCHASABLE',
      );
    }

    const existing = await this.repos.businessSubscriptions.findByBusiness(businessId);

    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      client_reference_id: businessId,
      ...(existing?.stripeCustomerId
        ? { customer: existing.stripeCustomerId }
        : { customer_email: userEmail }),
      subscription_data: {
        metadata: { businessId, planId: plan.id },
      },
    });

    if (!session.url) {
      throw new AppError('Stripe did not return a checkout URL.', 500, 'STRIPE_SESSION_ERROR');
    }
    return { url: session.url };
  }

  /**
   * Opens Stripe's hosted Customer Portal -- payment method updates, invoice
   * history, and (if the platform's Portal configuration allows it)
   * self-service cancellation all happen there, not in this codebase. A
   * business with no Stripe customer yet (never completed a checkout, e.g.
   * still card-less on the free trial) has nothing to manage there, so this
   * throws rather than opening an empty/broken portal session.
   */
  async createPortalSession(businessId: string, input: CreatePortalSessionInput): Promise<{ url: string }> {
    const subscription = await this.repos.businessSubscriptions.findByBusiness(businessId);
    if (!subscription?.stripeCustomerId) {
      throw new AppError(
        'No billing account yet -- subscribe to a plan first.',
        422,
        'NO_STRIPE_CUSTOMER',
      );
    }

    const session = await this.stripe.billingPortal.sessions.create({
      customer: subscription.stripeCustomerId,
      return_url: input.returnUrl,
    });

    return { url: session.url };
  }
}
