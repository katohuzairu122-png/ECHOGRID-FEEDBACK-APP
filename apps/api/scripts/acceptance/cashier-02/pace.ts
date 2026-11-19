/**
 * CASHIER-AUTH-02E E1: the staging authentication limiter is a real control (about 10 strict calls per minute per source). The harness
 * stays under it by spacing strict calls and by backing off on a 429; it never tries to avoid or weaken the limiter.
 */
export interface PacerOptions {
  strictIntervalMs?: number;
  retryDelayMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Pacer {
  run<T extends { status: number }>(strict: boolean, op: () => Promise<T>): Promise<T>;
  stats(): { strictCalls: number; throttled: number };
}

export const STRICT_PATH =
  /\/auth\/(login|cashier\/login|cashier\/managed-login|cashier\/session)$|\/cashier-accounts\/reauth$/;

export function createPacer(opts: PacerOptions = {}): Pacer {
  const interval = opts.strictIntervalMs ?? 6500;
  const retryDelay = opts.retryDelayMs ?? 20000;
  const maxRetries = opts.maxRetries ?? 5;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastStrict = Number.NEGATIVE_INFINITY;
  let strictCalls = 0;
  let throttled = 0;
  return {
    async run(strict, op) {
      for (let attempt = 0; ; attempt++) {
        if (strict) {
          const wait = lastStrict + interval - now();
          if (wait > 0) await sleep(wait);
          lastStrict = now();
          strictCalls++;
        }
        const result = await op();
        if (result.status !== 429) return result;
        throttled++;
        if (attempt >= maxRetries) return result;
        await sleep(retryDelay);
      }
    },
    stats: () => ({ strictCalls, throttled }),
  };
}
