import 'server-only';
import { customerApiFetch } from './customer-api-client';
import { rethrowControlFlow } from './rethrow-control-flow';

/**
 * BCOMM-04: the signed-in customer's OWN follows (handles of published businesses). A failure returns `null` ("unknown"), which the Feed
 * renders as no follow control at all; it is never guessed and never shown as "not following".
 */
const HANDLE = /^[A-Za-z0-9_-]{22}$/;

function parseHandles(raw: unknown): Set<string> {
  if (!Array.isArray(raw) || raw.length > 200) throw new Error('Invalid follows');
  const handles = raw.map((row) => {
    const handle = (row as { businessHandle?: unknown } | null)?.businessHandle;
    if (typeof handle !== 'string' || !HANDLE.test(handle)) throw new Error('Invalid follow');
    return handle;
  });
  return new Set(handles);
}

export async function getFollowedHandles(): Promise<Set<string> | null> {
  try {
    const raw = await customerApiFetch<unknown>('/network/follows', { cache: 'no-store' });
    return parseHandles(raw);
  } catch (error) {
    rethrowControlFlow(error);
    return null;
  }
}
