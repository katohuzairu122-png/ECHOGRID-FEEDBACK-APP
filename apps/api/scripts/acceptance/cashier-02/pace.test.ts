import { describe, expect, it } from 'vitest';
import { STRICT_PATH, createPacer } from './pace';

const fakeClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, sleeps };
};

describe('pacing', () => {
  it('spaces strict calls and does not delay others', async () => {
    const c = fakeClock();
    const p = createPacer({ now: c.now, sleep: c.sleep, strictIntervalMs: 6500 });
    await p.run(true, async () => ({ status: 200 }));
    await p.run(true, async () => ({ status: 200 }));
    await p.run(false, async () => ({ status: 200 }));
    expect(c.sleeps).toEqual([6500]);
    expect(p.stats().strictCalls).toBe(2);
  });
  it('backs off on 429 a bounded number of times and never loops forever', async () => {
    const c = fakeClock();
    const p = createPacer({ now: c.now, sleep: c.sleep, retryDelayMs: 100, maxRetries: 3 });
    let calls = 0;
    const r = await p.run(false, async () => { calls++; return { status: 429 }; });
    expect(r.status).toBe(429);
    expect(calls).toBe(4);
    expect(p.stats().throttled).toBe(4);
  });
  it('recovers when the limiter lets the call through', async () => {
    const c = fakeClock();
    const p = createPacer({ now: c.now, sleep: c.sleep, retryDelayMs: 10 });
    let n = 0;
    expect((await p.run(false, async () => ({ status: ++n < 3 ? 429 : 200 }))).status).toBe(200);
  });
  it('recognises the strict authentication endpoints', () => {
    for (const path of ['/auth/login', '/auth/cashier/managed-login', '/auth/cashier/session', '/cashier-accounts/reauth']) expect(STRICT_PATH.test(path)).toBe(true);
    for (const path of ['/auth/cashier/refresh', '/loyalty/actions/onboarding-invite']) expect(STRICT_PATH.test(path)).toBe(false);
  });
});
