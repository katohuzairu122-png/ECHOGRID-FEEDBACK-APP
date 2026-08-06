import { createDb } from '../db/client';
import { createRepositories, type Repositories } from '../repositories';

/**
 * Runs `fn` against a FRESH, independently-opened-and-closed DB connection --
 * for use inside `c.executionCtx.waitUntil()` callbacks that need repository
 * access after the route handler has already returned its response.
 *
 * Deliberately does NOT reuse the outer request's `db`/`repos`: that
 * connection is closed via its own separate `c.executionCtx.waitUntil(close())`
 * (see every route file's `withDb` helper), and Cloudflare Workers gives no
 * ordering guarantee between two independently-scheduled `waitUntil` tasks --
 * reusing the outer connection races that close() and fails intermittently.
 * This raced silently for a while (a fast `close()` losing to network
 * latency isn't guaranteed either way) until Hyperdrive query caching was
 * disabled and every query became a real round trip to Neon, which is what
 * actually surfaced it: EVERY notification this platform tried to send
 * (feedback_received, points_earned, tier_upgraded, reward_redeemed,
 * redemption_pending) was silently failing to enqueue.
 *
 * A failure here is logged, never thrown -- a background notification/side
 * effect failing must never look like the triggering request itself failed.
 */
export async function runInBackground(
  hyperdrive: Hyperdrive,
  fn: (repos: Repositories) => Promise<void>,
): Promise<void> {
  const { db, close } = await createDb(hyperdrive);
  try {
    await fn(createRepositories(db));
  } catch (err) {
    console.error('Background DB task failed:', err instanceof Error ? err.message : err);
  } finally {
    await close();
  }
}
