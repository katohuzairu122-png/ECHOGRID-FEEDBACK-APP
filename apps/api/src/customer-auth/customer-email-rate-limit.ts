import type { EmailAuthLimiter } from './customer-email-auth.routes';

type Counter = { resetsAt: number; count: number };
type CounterStore = Pick<DurableObjectTransaction, 'get' | 'put' | 'delete' | 'setAlarm'>;
const counterKey = 'window';
const budgets = new Set(['5/900', '3/3600', '10/3600']);

export async function spendEmailAuthBudget(
  store: CounterStore,
  now: number,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const current = await store.get<Counter>(counterKey);
  if (current && current.resetsAt > now) {
    if (current.count >= limit) return false;
    await store.put(counterKey, { ...current, count: current.count + 1 });
    return true;
  }

  const resetsAt = now + windowSeconds * 1000;
  await store.put(counterKey, { count: 1, resetsAt });
  await store.setAlarm(resetsAt);
  return true;
}

/** One shared counter per opaque key. No namespace binding is deployed by this change. */
export class CustomerEmailRateLimit {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const budget = new URL(request.url).pathname.slice(1);
    if (!budgets.has(budget)) return new Response(null, { status: 400 });
    const [limit, seconds] = budget.split('/').map(Number);
    if (limit === undefined || seconds === undefined) return new Response(null, { status: 400 });
    const allowed = await this.state.storage.transaction((tx) =>
      spendEmailAuthBudget(tx, Date.now(), limit, seconds),
    );
    return new Response(null, { status: allowed ? 204 : 429 });
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async (tx) => {
      const current = await tx.get<Counter>(counterKey);
      if (!current) return;
      if (current.resetsAt <= Date.now()) await tx.delete(counterKey);
      else await tx.setAlarm(current.resetsAt);
    });
  }
}

export function createSharedEmailAuthLimiter(namespace?: DurableObjectNamespace): EmailAuthLimiter {
  return async ({ key, limit, windowSeconds }) => {
    if (!namespace) throw new Error('Customer email limiter unavailable');
    const budget = `${limit}/${windowSeconds}`;
    if (!budgets.has(budget)) throw new Error('Unsupported customer email budget');
    const stub = namespace.get(namespace.idFromName(`${budget}:${key}`));
    const response = await stub.fetch(`https://customer-email-limiter/${budget}`, { method: 'POST' });
    if (response.status === 204) return true;
    if (response.status === 429) return false;
    throw new Error('Customer email limiter unavailable');
  };
}
