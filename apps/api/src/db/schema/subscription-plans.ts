import { pgTable, uuid, text, integer, boolean, jsonb, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { auditColumns } from './_shared';

/**
 * Platform-defined pricing catalog for the CEP's own SaaS subscription --
 * what a business pays Echo Grid Feedback to use the platform, not to be
 * confused with the Digital Loyalty module's "rewards"/"cashback" that a
 * business runs for ITS OWN customers. Rows are managed by platform admins
 * (Platform Admin Console Block 10 -- platform-level billing:manage
 * equivalent, not yet built), never created by a business itself. Same
 * "global, platform-defined catalog" shape as permissions.ts, for the same
 * reason: what a business can subscribe TO is a platform decision.
 *
 * Rows are never hard-deleted: isActive=false retires a plan from the
 * picker (new subscriptions can't select it) while preserving it forever
 * for existing subscriptions' FK integrity and historical reporting -- same
 * "archived, not deleted" precedent as businesses.status.
 */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stable, human-readable identifier independent of the display name --
    // renaming "Growth" to "Pro" in the UI never breaks a hardcoded
    // reference in a support script or seed file.
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    // Cached display values (integer cents, minor currency unit -- same
    // convention Stripe itself uses) so the plan picker never needs a live
    // Stripe call just to render prices. Stripe's Price object remains the
    // source of truth actually charged; keep these in sync with Stripe when
    // a plan's price changes (platform admin UI, future Block 10).
    priceMonthlyCents: integer('price_monthly_cents').notNull(),
    priceYearlyCents: integer('price_yearly_cents'),
    // ISO 4217, lowercase -- matches Stripe's own currency convention
    // (Stripe returns/expects lowercase, unlike businesses.defaultCurrency
    // which follows the uppercase ISO 4217 display convention instead).
    currency: text('currency').notNull().default('usd'),
    // Nullable: a plan can exist here (e.g. a platform admin drafting it)
    // before it's wired to a real Stripe Price, and a free/trial-only plan
    // may never need one at all.
    stripePriceIdMonthly: text('stripe_price_id_monthly'),
    stripePriceIdYearly: text('stripe_price_id_yearly'),
    // Nullable = unlimited. Never a hardcoded platform constant (see "never
    // hard-code limits") -- enforced wherever a branch is created / a team
    // member is invited (future integration; out of this block's scope).
    maxBranches: integer('max_branches'),
    maxUsers: integer('max_users'),
    // Open-ended feature flags (e.g. {"aiSummaries": true}) so future plan
    // differentiation doesn't require a schema migration per feature.
    features: jsonb('features'),
    isActive: boolean('is_active').notNull().default(true),
    // Exactly one plan is flagged as the card-less trial default that
    // BusinessService.createBusiness provisions new businesses onto (see
    // billing/subscription-provisioning.service.ts) -- an explicit flag
    // rather than "lowest sortOrder", since sortOrder is a display concern
    // and shouldn't silently double as functional trial-selection logic.
    isDefaultTrial: boolean('is_default_trial').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    ...auditColumns,
  },
  (table) => [
    uniqueIndex('subscription_plans_key_key').on(table.key),
    check('subscription_plans_price_monthly_check', sql`${table.priceMonthlyCents} >= 0`),
    check(
      'subscription_plans_price_yearly_check',
      sql`${table.priceYearlyCents} IS NULL OR ${table.priceYearlyCents} >= 0`,
    ),
    // At most one default-trial plan platform-wide -- a partial unique
    // index (only enforced where isDefaultTrial is true), since every other
    // row legitimately shares the same (false) value.
    uniqueIndex('subscription_plans_one_default_trial_idx')
      .on(table.isDefaultTrial)
      .where(sql`${table.isDefaultTrial} = true`),
  ],
);
