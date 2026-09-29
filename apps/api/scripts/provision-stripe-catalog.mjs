import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Stripe from 'stripe';
import pg from 'pg';

const CATALOG_VERSION = 'affordable-v1';
const CATALOG = [
  { key: 'starter', name: 'Echo Grid Starter', monthly: 900, yearly: 9000 },
  { key: 'growth', name: 'Echo Grid Growth', monthly: 2900, yearly: 29000 },
  { key: 'business', name: 'Echo Grid Business', monthly: 5900, yearly: 59000 },
];

function usage() {
  console.log(`Usage:
  pnpm billing:stripe:provision -- --test --apply [--connect]
  pnpm billing:stripe:provision -- --live --apply --connect

Options:
  --test       Require a Stripe test key and create test-mode objects
  --live       Require a Stripe live key and create live-mode objects
  --apply      Required acknowledgement before Stripe objects are created
  --connect    Store the resulting Price IDs in DATABASE_URL
  --help       Show this help
`);
}

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  usage();
  process.exit(0);
}

const requestedModes = ['--test', '--live'].filter((flag) => args.has(flag));
if (requestedModes.length !== 1) {
  throw new Error('Choose exactly one mode: --test or --live.');
}
if (!args.has('--apply')) {
  throw new Error('Dry safety stop: add --apply after reviewing the selected Stripe mode.');
}

const mode = args.has('--live') ? 'live' : 'test';
const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) throw new Error('STRIPE_SECRET_KEY is required.');
if (!secretKey.startsWith(`sk_${mode}_`)) {
  throw new Error(`--${mode} does not match the configured Stripe key.`);
}
if (args.has('--connect') && !process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required with --connect.');
}

const stripe = new Stripe(secretKey, { maxNetworkRetries: 2 });

async function findOrCreateProduct(plan) {
  for await (const product of stripe.products.list({ limit: 100 })) {
    if (
      product.metadata.echo_grid_plan_key === plan.key &&
      product.metadata.echo_grid_catalog_version === CATALOG_VERSION
    ) {
      return product;
    }
  }

  return stripe.products.create({
    name: plan.name,
    active: true,
    metadata: {
      echo_grid_plan_key: plan.key,
      echo_grid_catalog_version: CATALOG_VERSION,
    },
  });
}

async function findOrCreatePrice(product, plan, interval) {
  const unitAmount = interval === 'month' ? plan.monthly : plan.yearly;
  const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
  const existing = prices.data.find(
    (price) =>
      price.currency === 'usd' &&
      price.unit_amount === unitAmount &&
      price.recurring?.interval === interval &&
      price.metadata.echo_grid_plan_key === plan.key &&
      price.metadata.echo_grid_catalog_version === CATALOG_VERSION,
  );
  if (existing) return existing;

  return stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: unitAmount,
    recurring: { interval },
    nickname: `${plan.name} ${interval === 'month' ? 'Monthly' : 'Annual'}`,
    metadata: {
      echo_grid_plan_key: plan.key,
      echo_grid_catalog_version: CATALOG_VERSION,
      echo_grid_interval: interval,
    },
  });
}

const receipt = { mode, catalogVersion: CATALOG_VERSION, createdAt: new Date().toISOString(), plans: {} };

for (const plan of CATALOG) {
  const product = await findOrCreateProduct(plan);
  const monthly = await findOrCreatePrice(product, plan, 'month');
  const yearly = await findOrCreatePrice(product, plan, 'year');

  for (const [interval, price, expected] of [
    ['month', monthly, plan.monthly],
    ['year', yearly, plan.yearly],
  ]) {
    if (
      price.livemode !== (mode === 'live') ||
      price.currency !== 'usd' ||
      price.unit_amount !== expected ||
      price.recurring?.interval !== interval
    ) {
      throw new Error(`Stripe returned an invalid ${plan.key} ${interval} price.`);
    }
  }

  receipt.plans[plan.key] = {
    productId: product.id,
    monthlyPriceId: monthly.id,
    yearlyPriceId: yearly.id,
  };
}

if (args.has('--connect')) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const [key, ids] of Object.entries(receipt.plans)) {
      const result = await client.query(
        `UPDATE subscription_plans
         SET stripe_price_id_monthly = $1, stripe_price_id_yearly = $2, updated_at = now()
         WHERE key = $3 AND is_active = true`,
        [ids.monthlyPriceId, ids.yearlyPriceId, key],
      );
      if (result.rowCount !== 1) {
        throw new Error(`Active subscription plan "${key}" was not found in DATABASE_URL.`);
      }
    }
    await client.query('COMMIT');
    receipt.databaseConnected = true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

const artifactsDirectory = resolve(process.cwd(), 'artifacts');
await mkdir(artifactsDirectory, { recursive: true });
const receiptPath = resolve(artifactsDirectory, `stripe-catalog-${mode}.json`);
await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });

console.log(`Stripe ${mode}-mode catalog is ready.`);
console.log(`Receipt: ${receiptPath}`);
console.log(args.has('--connect') ? 'Price IDs connected to the database.' : 'Database unchanged; rerun with --connect when ready.');
