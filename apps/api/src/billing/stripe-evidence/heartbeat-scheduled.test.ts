import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as DbClient from '../../db/client';
import type * as HeartbeatModule from './heartbeat';

/**
 * B1: the real Worker `scheduled` entry point, on the existing every-5-minutes cron, must reach the evidence heartbeat and the
 * heartbeat must stay inert in every capture-off state. The database client is replaced so no connection can ever open; the
 * heartbeat itself is wrapped (real behavior, observable calls) rather than stubbed.
 */
const opened = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../db/client', async (orig) => ({
  ...(await orig<typeof DbClient>()),
  createDb: vi.fn(async () => { opened.count++; throw new Error('database unavailable in unit test'); }),
}));
vi.mock('./heartbeat', async (orig) => {
  const actual = await orig<typeof HeartbeatModule>();
  return { ...actual, runStripeEvidenceHeartbeat: vi.fn(actual.runStripeEvidenceHeartbeat) };
});

import worker from '../../index';
import { runStripeEvidenceHeartbeat } from './heartbeat';

const CRON = '*/5 * * * *';
const run = async (capture: string | undefined) => {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const env = { ENVIRONMENT: 'test', ...(capture === undefined ? {} : { STRIPE_EVIDENCE_CAPTURE: capture }) } as never;
  await worker.scheduled({ cron: CRON, scheduledTime: Date.now(), type: 'scheduled', noRetry: () => undefined } as never, env, ctx);
  await Promise.allSettled(pending);
  return vi.mocked(runStripeEvidenceHeartbeat).mock.results;
};

describe('scheduled entry point -> Stripe evidence heartbeat (B1)', () => {
  beforeEach(() => { vi.mocked(runStripeEvidenceHeartbeat).mockClear(); });

  it.each([['unset', undefined], ['empty string', ''], ['off', 'off']] as const)('cron fires the heartbeat and it resolves null with capture %s', async (_n, v) => {
    const results = await run(v);
    expect(results).toHaveLength(1);
    await expect(results[0]!.value).resolves.toBeNull();
  });

  it('enforced capture is not short-circuited: the heartbeat attempts the database', async () => {
    const before = opened.count;
    const results = await run('enforced');
    expect(results).toHaveLength(1);
    await expect(results[0]!.value).rejects.toThrow('database unavailable');
    expect(opened.count).toBeGreaterThan(before);
  });
});
